import re
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from .config import SERIAL_REGEX

Action = Literal['register', 'start-aging', 'h1', 'h2', 'h3', 'h4', 'post-aging']

class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

def validate_serial(value):
    value = value.strip()
    if len(value) > 64 or not re.fullmatch(SERIAL_REGEX, value) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', value):
        raise ValueError('Invalid serial number format')
    return value

class Capture(Strict):
    action: Action
    serial_number: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator('serial_number')
    @classmethod
    def serial(cls, value):
        return validate_serial(value) if value is not None else None

    @model_validator(mode='after')
    def target(self):
        if (self.action == 'register') != (self.serial_number is None):
            raise ValueError('Registration has no target; other captures require a registered serial')
        return self

ALLOWED_ISSUE_CATEGORIES = {'Display issue', 'Crashing / hanging issue', 'Other issue'}
ALLOWED_POWER_TEST = {'Pass', 'Fail', 'Hold'}

class Reading(Strict):
    serial_number: str = Field(min_length=1, max_length=64)
    battery_percent: int = Field(ge=0, le=100)
    device_timestamp: str | None = Field(default=None, max_length=16)
    capture_token: str = Field(min_length=20, max_length=100)
    has_issue: Literal['yes', 'no'] | None = Field(default=None)
    issue_categories: list[str] | None = Field(default=None)
    remarks: str | None = Field(default=None, max_length=1000)
    power_test_result: Literal['Pass', 'Fail', 'Hold'] | None = Field(default=None)

    @field_validator('serial_number')
    @classmethod
    def serial(cls, value):
        return validate_serial(value)

    @field_validator('device_timestamp')
    @classmethod
    def device_time(cls, value):
        if value is not None and not re.fullmatch(r'(?:0?[1-9]|1[0-2]):[0-5][0-9] (?:AM|PM)', value):
            raise ValueError('Device time must be HH:MM AM/PM or unavailable')
        return value

    @field_validator('issue_categories')
    @classmethod
    def validate_categories(cls, value):
        if value is not None:
            if not isinstance(value, list):
                raise ValueError('issue_categories must be a list')
            for c in value:
                if c not in ALLOWED_ISSUE_CATEGORIES:
                    raise ValueError(f'Invalid issue category: {c}')
        return value

    @model_validator(mode='after')
    def validate_issues(self):
        if self.has_issue == 'yes':
            if not self.issue_categories or len(self.issue_categories) == 0:
                raise ValueError('At least one issue category must be selected when has_issue is yes')
        elif self.has_issue == 'no':
            if self.issue_categories and len(self.issue_categories) > 0:
                raise ValueError('Issue categories must be empty when has_issue is no')
        return self

class Restart(Strict):
    checkpoint: int = Field(ge=1, le=4)
    confirmed: Literal[True]

    @field_validator('confirmed', mode='before')
    @classmethod
    def strict_confirmation(cls, value):
        if value is not True:
            raise ValueError('Explicit true confirmation required')
        return value

class Device(BaseModel):
    serial_number: str
    status: str
    pending_restart: int | None
    next_checkpoint: int
    aging_started: str | None
    next_due: str | None
    last_server_received: str
    last_device_time: str | None
    last_battery: int
    values: list
    observations: dict | None = None
    power_test_result: str | None = None

