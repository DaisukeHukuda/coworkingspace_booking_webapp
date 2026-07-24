export type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL_FROM?: string;
  APP_ORIGIN?: string;         // メール本文の管理画面リンクに使う絶対URL（未設定ならリクエストoriginを使う）
  SQUARE_ACCESS_TOKEN?: string; // Square Bookings API のアクセストークン（secret）
  SQUARE_API_BASE?: string;     // Square APIのベースURL（未設定なら https://connect.squareup.com）
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

export interface AvailabilityCacheRow {
  date: string;       // 'YYYY-MM-DD'
  slots_json: string; // JSON配列文字列（開始時刻 'HH:MM' の配列）
  fetched_at: string; // ISO文字列（UTC）
}
