export interface LocationView {
  state: 'unavailable' | 'off' | 'waiting' | 'stale' | 'live';
  serverTime: string;
  canShare: boolean;
  session: { id: string; expiresAt: string; nextSequence: number } | null;
  point: {
    latitude: number;
    longitude: number;
    accuracy: number;
    measuredAt: string;
    receivedAt: string;
    validUntil: string;
  } | null;
}
