/** Hacker News Firebase API の item レスポンス（利用フィールドのみ） */
export type HnItem = {
  id: number;
  type?: string;
  deleted?: boolean;
  dead?: boolean;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  by?: string;
  time?: number;
  descendants?: number;
  kids?: number[];
};
