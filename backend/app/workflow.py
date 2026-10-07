import hashlib
import json
import secrets
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException
from .config import CAPTURE_TTL, CHECKPOINT_SECONDS
from .storage import Store, extract_observations_from_row, sanitize_formula_injection
from .supabase_sync import sync_device_to_supabase, fetch_device_from_supabase, delete_device_from_supabase


def now():
    return datetime.now(timezone.utc)


def reject(message):
    raise HTTPException(409, message)


class Workflow:
    def __init__(self, store, interval=CHECKPOINT_SECONDS):
        self.store = store
        self.interval = interval

    @staticmethod
    def revision(state):
        return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()

    def restore_from_supabase_row(self, book, sb_row):
        serial = sb_row['serial_number']
        sheet = book['Devices']
        row_vals = [
            serial,
            sb_row.get('registration_time'),
            sb_row.get('registration_battery'),
            sb_row.get('h1_battery'),
            sb_row.get('h1_timestamp'),
            sb_row.get('h2_battery'),
            sb_row.get('h2_timestamp'),
            sb_row.get('h3_battery'),
            sb_row.get('h3_timestamp'),
            sb_row.get('h4_battery'),
            sb_row.get('h4_timestamp'),
            sb_row.get('post_aging_battery'),
            sb_row.get('post_aging_timestamp'),
            sb_row.get('status', 'WAITING_FOR_100_PERCENT_CHARGE'),
        ] + [None] * 16
        sheet.append(row_vals)
        row = sheet.max_row

        obs = sb_row.get('observations') or {}
        for n in range(1, 5):
            o = obs.get(f'h{n}')
            if o and isinstance(o, dict):
                sheet.cell(row, 15 + 3 * (n - 1), 'Yes' if o.get('has_issue') == 'yes' else 'No')
                sheet.cell(row, 16 + 3 * (n - 1), ', '.join(o.get('categories', [])))
                sheet.cell(row, 17 + 3 * (n - 1), sanitize_formula_injection(o.get('remarks', '')))
        post_o = obs.get('post')
        if post_o and isinstance(post_o, dict):
            sheet.cell(row, 27, 'Yes' if post_o.get('has_issue') == 'yes' else 'No')
            sheet.cell(row, 28, ', '.join(post_o.get('categories', [])))
            sheet.cell(row, 29, sanitize_formula_injection(post_o.get('remarks', '')))
        if sb_row.get('power_test_result'):
            sheet.cell(row, 30, sb_row.get('power_test_result'))

        state = {
            'serial_number': serial,
            'status': sb_row.get('status', 'WAITING_FOR_100_PERCENT_CHARGE'),
            'pending_restart': sb_row.get('pending_restart'),
            'next_checkpoint': sb_row.get('next_checkpoint', 1),
            'aging_started': sb_row.get('aging_started'),
            'next_due': sb_row.get('next_due'),
            'events': sb_row.get('events', []),
            'registration_device_time': sb_row.get('last_device_time'),
            'last_device_time': sb_row.get('last_device_time'),
            'last_battery': sb_row.get('last_battery'),
            'last_server_received': sb_row.get('last_server_received'),
            'observations': obs,
            'power_test_result': sb_row.get('power_test_result'),
        }
        book['Workflow'].append([serial, json.dumps(state)])
        meta = book['Workflow'].max_row
        return row, meta, state

    def find_device(self, book, serial):
        found = Store.locate(book, serial)
        if not found:
            sb_row = fetch_device_from_supabase(serial)
            if sb_row:
                row, meta, state = self.restore_from_supabase_row(book, sb_row)
                found = (row, meta, state)
        return found

    def capture(self, request):
        def operation(book):
            sheet = book['Captures']
            cutoff = now() - timedelta(seconds=CAPTURE_TTL)
            for index in range(sheet.max_row, 1, -1):
                if datetime.fromisoformat(sheet.cell(index, 4).value) < cutoff:
                    sheet.delete_rows(index)
            if sheet.max_row > 500:
                raise HTTPException(429, 'Too many pending captures. Wait three minutes and retry.')
            revision = None
            if request.serial_number:
                found = self.find_device(book, request.serial_number)
                if not found:
                    raise HTTPException(404, 'Device not registered.')
                revision = self.revision(found[2])
            token = secrets.token_urlsafe(32)
            sheet.append([token, request.action, request.serial_number, now().isoformat(), False, revision])
            return {'capture_token': token, 'expires_in': CAPTURE_TTL}
        return self.store.transaction(operation)

    def consume(self, book, reading, action, target):
        for row in book['Captures'].iter_rows(min_row=2):
            if row[0].value == reading.capture_token:
                if row[4].value or row[1].value != action or row[2].value != target:
                    reject('Capture already used or belongs to a different action. Capture again.')
                age = (now() - datetime.fromisoformat(row[3].value)).total_seconds()
                if age < 0 or age > CAPTURE_TTL:
                    reject('Capture expired. Please capture a fresh reading.')
                if target:
                    found = Store.locate(book, target)
                    if not found or row[5].value != self.revision(found[2]):
                        reject('Device changed since this capture began. Refresh and capture again.')
                row[4].value = True
                return
        reject('Capture expired or unavailable. Please capture again.')

    def get(self, serial):
        def operation(book):
            found = self.find_device(book, serial)
            if not found:
                raise HTTPException(404, 'Device not registered.')
            row, _, state = found
            return self.response(book, row, state)
        return self.store.transaction(operation, False)

    def response(self, book, row, state):
        excel_status = book['Devices'].cell(row, 14).value
        if excel_status and excel_status != state.get('status'):
            state['status'] = excel_status
        obs, power = extract_observations_from_row(book['Devices'], row)
        state['observations'] = obs
        state['power_test_result'] = power
        return {**state, 'values': [book['Devices'].cell(row, c).value for c in range(1, 31)]}

    def reading(self, action, reading, target=None):
        def operation(book):
            serial = reading.serial_number
            if target is not None and serial != target:
                reject('Serial mismatch. Capture the selected device.')
            found = self.find_device(book, serial)
            if action == 'register' and found:
                reject('Device already registered. Current status: ' + found[2]['status'])
            if action != 'register' and not found:
                raise HTTPException(404, 'Device not registered.')
            self.consume(book, reading, action, target)
            stamp = now().isoformat()
            sheet = book['Devices']
            if action == 'register':
                sheet.append([serial, stamp, reading.battery_percent] + [None] * 27)
                row = sheet.max_row
                state = {'serial_number': serial, 'status': 'READY_FOR_AGING' if reading.battery_percent == 100 else 'WAITING_FOR_100_PERCENT_CHARGE',
                         'pending_restart': None, 'next_checkpoint': 1, 'aging_started': None, 'next_due': None,
                         'events': [], 'registration_device_time': reading.device_timestamp,
                         'observations': {'h1': None, 'h2': None, 'h3': None, 'h4': None, 'post': None},
                         'power_test_result': None}
                book['Workflow'].append([serial, '{}'])
                meta = book['Workflow'].max_row
            else:
                row, meta, state = found
                if state['pending_restart']:
                    reject('Confirm the manual restart before continuing.')
                if action == 'start-aging':
                    if state['status'] not in ['READY_FOR_AGING', 'WAITING_FOR_100_PERCENT_CHARGE']:
                        reject('Aging has already started or is unavailable.')
                    if reading.battery_percent != 100:
                        reject('Charge to 100% and capture a fresh reading before starting aging.')
                    state['status'] = 'AGING_HOUR_1'
                    state['aging_started'] = stamp
                    state['next_due'] = (now() + timedelta(seconds=self.interval)).isoformat()
                elif action in ['h1', 'h2', 'h3', 'h4']:
                    n = int(action[1])
                    if n == 1 and state['status'] in ['READY_FOR_AGING', 'WAITING_FOR_100_PERCENT_CHARGE']:
                        state['status'] = 'AGING_HOUR_1'
                        state['aging_started'] = stamp
                        state['next_due'] = stamp
                    if state['status'] != f'AGING_HOUR_{n}' or state['next_checkpoint'] != n:
                        reject('Checkpoints must follow H1, H2, H3, H4 in order.')
                    if state.get('next_due') and now() < datetime.fromisoformat(state['next_due']):
                        reject('This hourly checkpoint is not due yet.')
                    if n == 1 and reading.battery_percent != 100:
                        reject('Strict Rule: Checkpoint H1 requires 100% battery charge. Charge device to 100% before proceeding.')
                    sheet.cell(row, 2 * n + 2, reading.battery_percent)
                    sheet.cell(row, 2 * n + 3, reading.device_timestamp)
                    if reading.has_issue is not None:
                        sheet.cell(row, 15 + 3 * (n - 1), 'Yes' if reading.has_issue == 'yes' else 'No')
                        sheet.cell(row, 16 + 3 * (n - 1), ', '.join(reading.issue_categories) if reading.issue_categories else None)
                        sheet.cell(row, 17 + 3 * (n - 1), sanitize_formula_injection(reading.remarks))
                        state.setdefault('observations', {})[f'h{n}'] = {
                            'has_issue': reading.has_issue,
                            'categories': reading.issue_categories or [],
                            'remarks': reading.remarks or ''
                        }
                    state['pending_restart'] = n
                    state['next_due'] = None
                elif action == 'post-aging':
                    if state['status'] not in ['AGING_TEST_COMPLETE', 'POST_AGING_CHARGE']:
                        reject('Complete H4 and confirm restart before post-aging charge.')
                    sheet.cell(row, 12, reading.battery_percent)
                    # Assignment permits clearing an unavailable time after an earlier reading.
                    sheet.cell(row, 13).value = reading.device_timestamp
                    if reading.has_issue is not None:
                        sheet.cell(row, 27, 'Yes' if reading.has_issue == 'yes' else 'No')
                        sheet.cell(row, 28, ', '.join(reading.issue_categories) if reading.issue_categories else None)
                        sheet.cell(row, 29, sanitize_formula_injection(reading.remarks))
                        state.setdefault('observations', {})['post'] = {
                            'has_issue': reading.has_issue,
                            'categories': reading.issue_categories or [],
                            'remarks': reading.remarks or ''
                        }
                    if reading.power_test_result is not None:
                        sheet.cell(row, 30, reading.power_test_result)
                        state['power_test_result'] = reading.power_test_result
                    state['status'] = 'PACKING_READY' if reading.battery_percent >= 70 else 'POST_AGING_CHARGE'
            state.update(last_server_received=stamp, last_device_time=reading.device_timestamp, last_battery=reading.battery_percent)
            event_item = {
                'action': action,
                'battery': reading.battery_percent,
                'device_time': reading.device_timestamp,
                'server_received': stamp
            }
            if reading.has_issue is not None:
                event_item['has_issue'] = reading.has_issue
                event_item['issue_categories'] = reading.issue_categories or []
                event_item['remarks'] = reading.remarks
            if reading.power_test_result is not None:
                event_item['power_test_result'] = reading.power_test_result
            state['events'].append(event_item)
            sheet.cell(row, 14, state['status'])
            encoded = json.dumps(state)
            if len(encoded) > 30000:
                reject('Device event history is full. Ask a supervisor to archive this record.')
            book['Workflow'].cell(meta, 2, encoded)
            resp = self.response(book, row, state)
            sync_device_to_supabase(state, resp.get('values'))
            return resp
        return self.store.transaction(operation)

    def restart(self, serial, request):
        def operation(book):
            found = self.find_device(book, serial)
            if not found:
                raise HTTPException(404, 'Device not registered.')
            row, meta, state = found
            n = request.checkpoint
            if state['pending_restart'] != n:
                reject('No matching restart is awaiting confirmation.')
            stamp = now()
            state['events'].append({'action': 'operator_restart_confirmation', 'checkpoint': n, 'server_received': stamp.isoformat()})
            state['pending_restart'] = None
            state['next_checkpoint'] = n + 1
            state['status'] = 'AGING_TEST_COMPLETE' if n == 4 else f'AGING_HOUR_{n + 1}'
            state['next_due'] = None if n == 4 else (stamp + timedelta(seconds=self.interval)).isoformat()
            book['Devices'].cell(row, 14, state['status'])
            encoded = json.dumps(state)
            if len(encoded) > 30000:
                reject('Device event history is full. Ask a supervisor to archive this record.')
            book['Workflow'].cell(meta, 2, encoded)
            resp = self.response(book, row, state)
            sync_device_to_supabase(state, resp.get('values'))
            return resp
        return self.store.transaction(operation)

    def delete(self, serial: str):
        def operation(book):
            found = self.find_device(book, serial)
            if not found:
                raise HTTPException(404, 'Device not registered.')
            dev_row, meta_row, _ = found
            book['Devices'].delete_rows(dev_row)
            Store.reconcile(book)
            delete_device_from_supabase(serial)
            return {'status': 'deleted', 'serial_number': serial}
        return self.store.transaction(operation)
