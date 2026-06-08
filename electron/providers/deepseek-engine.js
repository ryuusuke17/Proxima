/**
 * Proxima — DeepSeek Engine v4.1.0
 * Runs inside chat.deepseek.com BrowserView context. Uses session cookies for auth,
 * sends queries via internal chat API and parses SSE streaming responses.
 */
(function() {
    if (window.__proximaDeepSeek) return;

    var API_BASE = '/api/v0';
    var TIMEOUT = 360000;

    // ─── State ───────────────────────────────────────
    var _cachedToken = null;
    var _tokenExpiry = 0;
    var _conversationId = null;
    var _parentId = null;

    // ─── Auth Token ──────────────────────────────────

    async function _getToken() {
        if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

        // Try from localStorage first (DeepSeek stores auth there after login)
        try {
            var stored = localStorage.getItem('auth_token');
            if (stored) {
                _cachedToken = stored;
                _tokenExpiry = Date.now() + 300000; // 5 min TTL
                return _cachedToken;
            }
        } catch(e) {}

        // Try session endpoint
        try {
            var res = await fetch('/api/v0/auth/session', { credentials: 'include' });
            if (res.ok) {
                var data = await res.json();
                if (data.token || data.accessToken) {
                    _cachedToken = data.token || data.accessToken;
                    _tokenExpiry = Date.now() + 300000;
                    return _cachedToken;
                }
            }
        } catch(e) {}

        // Fallback: try cookie-based auth
        try {
            var cookies = document.cookie.split(';');
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                // DeepSeek uses various cookie names for auth
                if (c.startsWith('deepseek_token=') || c.startsWith('auth_token=') || c.startsWith('session=')) {
                    _cachedToken = c.split('=').slice(1).join('=');
                    _tokenExpiry = Date.now() + 300000;
                    return _cachedToken;
                }
            }
        } catch(e) {}

        throw new Error('Not logged in to DeepSeek');
    }

    // ─── SSE Stream Parser ──────────────────────────

    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var buffer = '';

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line.startsWith('data:')) continue;
                var data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;

                try {
                    var parsed = JSON.parse(data);

                    // DeepSeek streaming format — collect delta content
                    if (parsed.choices && parsed.choices.length > 0) {
                        var delta = parsed.choices[0].delta;
                        if (delta && delta.content) {
                            fullText += delta.content;
                        }
                    }

                    // Alternative format — direct text field
                    if (parsed.text && typeof parsed.text === 'string') {
                        fullText = parsed.text;
                    }

                    // Alternative format — content field
                    if (parsed.content && typeof parsed.content === 'string') {
                        fullText = parsed.content;
                    }

                    // Track conversation ID for follow-ups
                    if (parsed.conversation_id) {
                        _conversationId = parsed.conversation_id;
                    }
                    if (parsed.parent_id) {
                        _parentId = parsed.parent_id;
                    }
                    if (parsed.id && !_conversationId) {
                        _conversationId = parsed.id;
                    }

                    // Handle error responses in stream
                    if (parsed.error) {
                        throw new Error('DeepSeek API error: ' + (parsed.error.message || JSON.stringify(parsed.error)));
                    }
                } catch(e) {
                    if (e.message && e.message.startsWith('DeepSeek')) throw e;
                }
            }
        }

        reader.releaseLock();

        fullText = fullText.trim();
        return fullText;
    }

    // ─── Send Message ───────────────────────────────

    async function send(message) {
        var token = await _getToken();

        // Build payload — OpenAI-compatible format
        var payload = {
            messages: [
                { role: 'user', content: message }
            ],
            stream: true,
            model: 'deepseek-chat'
        };

        // Add conversation context for follow-ups
        if (_conversationId) {
            payload.conversation_id = _conversationId;
        }

        var headers = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': 'Bearer ' + token
        };

        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT);

        var res = await fetch(API_BASE + '/chat/completions', {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        // Token expired — refresh and retry once
        if (res.status === 401) {
            _cachedToken = null;
            _tokenExpiry = 0;
            token = await _getToken();
            headers['Authorization'] = 'Bearer ' + token;

            var retryController = new AbortController();
            var retryTimeoutId = setTimeout(function() { retryController.abort(); }, TIMEOUT);
            res = await fetch(API_BASE + '/chat/completions', {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(payload),
                signal: retryController.signal
            });
            if (!res.ok) {
                clearTimeout(retryTimeoutId);
                var errText = await res.text().catch(function() { return ''; });
                throw new Error('DeepSeek API error (' + res.status + '): ' + errText.substring(0, 300));
            }
            var result = await _parseStream(res);
            clearTimeout(retryTimeoutId);
            return result;
        }

        // Handle API errors
        if (!res.ok) {
            clearTimeout(timeoutId);
            if (res.status === 401 || res.status === 403) {
                _cachedToken = null;
                throw new Error('Not logged in to DeepSeek');
            }
            if (res.status === 429) throw new Error('DeepSeek rate limited');
            var errText = await res.text().catch(function() { return ''; });
            throw new Error('DeepSeek API error (' + res.status + '): ' + errText.substring(0, 300));
        }

        // Handle non-streaming JSON response
        var contentType = res.headers.get('content-type') || '';
        if (contentType.startsWith('application/json')) {
            clearTimeout(timeoutId);
            var json = await res.json();
            if (json.choices && json.choices.length > 0) {
                var content = json.choices[0].message && json.choices[0].message.content;
                if (content) {
                    return content;
                }
            }
            if (json.content) return json.content;
            if (json.text) return json.text;
            throw new Error('DeepSeek returned empty response');
        }

        var result = await _parseStream(res);
        clearTimeout(timeoutId);

        if (!result || result.length === 0) {
            throw new Error('DeepSeek returned empty response');
        }

        return result;
    }

    // ─── New Conversation ───────────────────────────

    function newConversation() {
        _conversationId = null;
        _parentId = null;
        _cachedToken = null;
        _tokenExpiry = 0;
        console.log('[Proxima DeepSeek] Conversation reset');
    }

    window.__proximaDeepSeek = { send: send, newConversation: newConversation };
    console.log('[Proxima] DeepSeek engine loaded');

    // Pre-warm auth
    _getToken().catch(function(){});
})();
