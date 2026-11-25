export type Fields = Record<string, unknown>;

export interface Summary {
  startedAt: number;
  sport: string;
  distanceM: number | null;
  activeSeconds: number | null;
  avgHr: number | null;
}

export interface CloudWorkout extends Summary {
  sourceKey: string;
  modifiedAt: number | null;
  cloud: Fields;
}

export interface CloudIndex {
  workouts: CloudWorkout[];
  highWatermark: number;
  timeZone?: string;
}

export interface Analysis {
  summary: Summary;
  metrics: Fields;
  laps: Fields[];
  observations: string[];
  fitSha256: string;
  chart: boolean;
  deviceModel?: string | null;
}
