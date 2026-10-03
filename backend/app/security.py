"""Small, bounded ASGI request guard for the single-laptop deployment."""
import asyncio
import sys

if sys.version_info >= (3, 11):
    from asyncio import timeout as async_timeout_cm
else:
    from async_timeout import timeout as async_timeout_cm
import json
import time
from collections import deque
from urllib.parse import urlsplit
from starlette.responses import JSONResponse


class SecurityGuard:
    def __init__(self, app, hosts, origins, limit=600):
        self.app = app
        self.hosts = set(hosts)
        self.origins = set(origins)
        self.limit = limit
        self.requests = deque()

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = dict(scope['headers'])

        async def secured_send(message):
            if message['type'] == 'http.response.start':
                message['headers'] = list(message.get('headers', [])) + [
                    (b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff'),
                    (b'x-frame-options', b'DENY'), (b'referrer-policy', b'no-referrer')]
            await send(message)

        async def reject(status, detail):
            await JSONResponse({'detail': detail}, status)(scope, receive, secured_send)

        try:
            host = urlsplit('http://' + headers.get(b'host', b'').decode('ascii')).hostname
        except (ValueError, UnicodeDecodeError):
            host = None
        if '*' not in self.hosts and host not in self.hosts:
            return await reject(400, 'Unrecognized server address.')
        origin = headers.get(b'origin', b'').decode('latin1')
        if '*' not in self.origins:
            if (origin and origin not in self.origins) or headers.get(b'sec-fetch-site') == b'cross-site':
                return await reject(403, 'Cross-site requests are not permitted.')
        current = time.monotonic()
        while self.requests and self.requests[0] < current - 60:
            self.requests.popleft()
        if len(self.requests) >= self.limit:
            return await reject(429, 'Too many requests. Wait a minute and retry.')
        self.requests.append(current)
        if scope['method'] == 'POST':
            # /api/battery-ocr uses multipart/form-data (image upload).
            # All other routes require JSON and are capped at 4 096 bytes.
            path = scope.get('path', '')
            is_ocr = path == '/api/battery-ocr'
            content_type = headers.get(b'content-type', b'').split(b';')[0].strip().lower()
            if not is_ocr and content_type != b'application/json':
                return await reject(415, 'Only structured JSON readings are accepted.')
            try:
                length = int(headers.get(b'content-length', b'0'))
            except ValueError:
                return await reject(400, 'Invalid request size.')
            max_body = 8 * 1024 * 1024 if is_ocr else 4096
            if length < 0 or length > max_body:
                return await reject(413, 'Request too large.')
            # For multipart image upload: let FastAPI stream it directly.
            if is_ocr:
                return await self.app(scope, receive, secured_send)

            body = bytearray()
            try:
                async with async_timeout_cm(10):
                    while True:
                        chunk = await receive()
                        if chunk['type'] == 'http.disconnect':
                            return
                        if len(body) + len(chunk.get('body', b'')) > 4096:
                            return await reject(413, 'Request too large.')
                        body.extend(chunk.get('body', b''))
                        if not chunk.get('more_body', False):
                            break
            except TimeoutError:
                return await reject(408, 'Request timed out.')

            def unique_pairs(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError('Duplicate key')
                    result[key] = value
                return result

            def invalid_constant(_value):
                raise ValueError('Invalid number')

            try:
                value = json.loads(body, object_pairs_hook=unique_pairs, parse_constant=invalid_constant)
                if not isinstance(value, dict):
                    raise ValueError('Object required')
            except (ValueError, UnicodeDecodeError, RecursionError):
                return await reject(422, 'Invalid JSON object.')
            delivered = False

            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
                return await receive()
            return await self.app(scope, bounded_receive, secured_send)
        return await self.app(scope, receive, secured_send)

