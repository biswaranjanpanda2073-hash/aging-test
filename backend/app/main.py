from zipfile import BadZipFile
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from filelock import Timeout
from . import config
from .schemas import Capture, Reading, Restart, Device
from .storage import Store
from .workflow import Workflow
from .security import SecurityGuard


def create_app(path=config.FILE, interval=config.CHECKPOINT_SECONDS, hosts=None, origins=None, rate_limit=600):
    app = FastAPI(title='Production Aging Test', docs_url=None, redoc_url=None, openapi_url=None)
    workflow = Workflow(Store(path), interval)
    app.state.workflow = workflow

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, _error):
        return JSONResponse({'detail': 'Device information could not be validated. Check serial, battery and device time.'}, 422)

    @app.exception_handler(ValueError)
    async def workbook_error(_request, _error):
        return JSONResponse({'detail': 'Workbook format or workflow metadata is invalid. Existing data was preserved; ask your supervisor to inspect it.'}, 503)

    @app.exception_handler(PermissionError)
    async def locked(_request, _error):
        return JSONResponse({'detail': 'Close the workbook in Excel and retry. Nothing was saved.'}, 503)

    @app.exception_handler(OSError)
    @app.exception_handler(BadZipFile)
    async def storage_error(_request, _error):
        return JSONResponse({'detail': 'Workbook could not be accessed or saved. Check disk space, file permissions and workbook integrity.'}, 503)

    @app.exception_handler(Timeout)
    async def busy(_request, _error):
        return JSONResponse({'detail': 'Workbook busy. Please retry.'}, 503)

    @app.get('/api/health')
    def health():
        workflow.store.transaction(lambda book: None, False)
        return {'status': 'ok'}

    @app.get('/api/config')
    def settings():
        return {'serial_regex': config.SERIAL_REGEX, 'checkpoint_interval_seconds': interval}

    @app.post('/api/captures')
    def capture(request: Capture):
        return workflow.capture(request)

    @app.post('/api/devices/register', response_model=Device)
    def register(reading: Reading):
        return workflow.reading('register', reading)

    @app.get('/api/devices/{serial}', response_model=Device)
    @app.get('/api/devices/{serial}/status', response_model=Device)
    def device(serial: str):
        return workflow.get(serial)

    @app.delete('/api/devices/{serial}')
    @app.post('/api/devices/{serial}/delete')
    def delete_device(serial: str):
        return workflow.delete(serial)

    @app.post('/api/devices/{serial}/restart', response_model=Device)
    def restart(serial: str, request: Restart):
        return workflow.restart(serial, request)

    @app.post('/api/devices/{serial}/aging/{checkpoint}', response_model=Device)
    def checkpoint(serial: str, checkpoint: str, reading: Reading):
        if checkpoint not in ['h1', 'h2', 'h3', 'h4']:
            raise HTTPException(404, 'Unknown checkpoint.')
        return workflow.reading(checkpoint, reading, serial)

    @app.post('/api/devices/{serial}/{action}', response_model=Device)
    def reading(serial: str, action: str, reading: Reading):
        if action not in ['start-aging', 'post-aging']:
            raise HTTPException(404, 'Unknown action.')
        return workflow.reading(action, reading, serial)

    app.add_middleware(SecurityGuard, hosts=hosts or config.ALLOWED_HOSTS, origins=origins or config.ALLOWED_ORIGINS, limit=rate_limit)
    return app

app = create_app()
