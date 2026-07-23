export type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
};

export type MemberType = 'monthly' | 'ticket';

export interface MemberRow {
  id: number;
  name: string;
  email: string;
  member_type: MemberType;
  token: string;
  is_active: number; // 1 | 0
  created_at: string;
}

export type RequestStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface RequestRow {
  id: number;
  member_id: number;
  date: string;       // 'YYYY-MM-DD'
  start_time: string; // 'HH:MM'
  end_time: string;   // 'HH:MM'
  status: RequestStatus;
  member_note: string;
  admin_note: string;
  created_at: string;
  updated_at: string;
}
