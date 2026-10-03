import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://nufzfmkplcspwhwnarbc.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51ZnpmbWtwbGNzcHdod25hcmJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NDU1OTIsImV4cCI6MjEwNjQyMTU5Mn0.3gZJWDJwGy7QVirYaiW_erpXlsx2TohKrqRieLqT9c8';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
