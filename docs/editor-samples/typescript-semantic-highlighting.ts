export interface QueryOptions {
  readonly endpoint: string;
  retries?: number;
}

export type ResultMap = Record<string, number>;

export enum RequestState {
  Idle = "idle",
  Loading = "loading",
  Ready = "ready",
}

export class QueryClient {
  readonly endpoint: string;

  constructor(private readonly options: QueryOptions) {
    this.endpoint = options.endpoint;
  }

  async fetchJson<TResponse>(
    path: string,
    transform: (payload: unknown) => TResponse
  ): Promise<TResponse> {
    const response = await fetch(`${this.endpoint}${path}`);
    const payload = await response.json();
    return transform(payload);
  }
}

export function summarizeResults(
  results: ResultMap,
  formatter: Intl.NumberFormat
): string[] {
  const entries = Object.entries(results);
  const rankedEntries = entries.map(([name, value], index) => ({
    name,
    value,
    label: `${index + 1}.${formatter.format(value)}`,
  }));

  const [topEntry] = rankedEntries;
  if (!topEntry) return [];

  return rankedEntries.map(({ name, label }) => `${name}:${label}`);
}
