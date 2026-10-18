export interface DispatchPreview {
  shipmentVersion: number;
  priority: 'normal' | 'urgent';
  token: string;
  method: 'straight-line' | 'road';
  spatial?: {
    index: 'h3' | 'exhaustive';
    resolution: number;
    cells: number;
    scannedCouriers: number;
    totalCouriers: number;
  };
  routing?: {
    state: 'disabled' | 'available' | 'unavailable';
    provider: string | null;
    evaluated: number;
    notEvaluated: number;
    unreachable: number;
    expiresAt: string;
    note: string;
  };
  policy: string;
  candidates: {
    id: string;
    name: string;
    freeKg: number;
    jobs: number;
    utilization: number;
    distanceKm: number;
    measuredAt: string;
    roadDistanceKm?: number;
    durationSeconds?: number;
  }[];
  excluded: Record<string, number>;
  blocked: string | null;
}
