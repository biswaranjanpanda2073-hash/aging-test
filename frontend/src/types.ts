export type Action = 'register' | 'start-aging' | 'h1' | 'h2' | 'h3' | 'h4' | 'post-aging';
export interface Fields {serial_number:string; battery_percent:number; device_timestamp:string|null}
export interface Reading extends Fields {capture_token:string}
export interface Device {serial_number:string;status:string;pending_restart:number|null;next_checkpoint:number;aging_started:string|null;next_due:string|null;last_server_received:string;last_device_time:string|null;last_battery:number;values:(string|number|null)[]}
