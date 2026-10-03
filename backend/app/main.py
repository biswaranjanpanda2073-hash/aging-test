import os
from zipfile import BadZipFile
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from filelock import Timeout  # type: ignore
from . import config
from .schemas import Capture, Reading, Restart, Device
from .storage import Store
from .workflow import Workflow
from .security import SecurityGuard
from .battery_ocr import run_battery_ocr


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

    @app.post('/api/battery-ocr')
    async def battery_ocr(
        image: UploadFile = File(...),
        crop_x: float | None = Form(default=None),
        crop_y: float | None = Form(default=None),
        crop_w: float | None = Form(default=None),
        crop_h: float | None = Form(default=None),
    ):
        """OCR a battery percentage from an uploaded image.

        Accepts multipart/form-data with fields:
          image   – JPEG or PNG file (required)
          crop_x, crop_y, crop_w, crop_h – fractional crop coordinates (optional)
        """
        if image.content_type not in ('image/jpeg', 'image/png', 'image/webp'):
            raise HTTPException(415, 'Only JPEG, PNG or WebP images are accepted.')
        data = await image.read(8 * 1024 * 1024)  # 8 MB cap
        if len(data) > 8 * 1024 * 1024:
            raise HTTPException(413, 'Image exceeds 8 MB limit.')
        result = run_battery_ocr(
            data,
            crop_x=crop_x,
            crop_y=crop_y,
            crop_w=crop_w,
            crop_h=crop_h,
        )
        return result

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

    active_origins = origins or config.ALLOWED_ORIGINS
    if os.getenv('RENDER') or os.getenv('ENVIRONMENT') == 'production' or os.getenv('ENABLE_CORS'):
        app.add_middleware(
            CORSMiddleware,
            allow_origins=['*'] if '*' in active_origins else active_origins,
            allow_credentials=True,
            allow_methods=['*'],
            allow_headers=['*'],
        )
    app.add_middleware(SecurityGuard, hosts=hosts or config.ALLOWED_HOSTS, origins=active_origins, limit=rate_limit)
    return app

app = create_app()
