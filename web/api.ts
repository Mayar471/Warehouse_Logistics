export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      result.code ?? 'ERROR',
      result.message ?? 'تعذر إتمام العملية',
      response.status,
    );
  return result as T;
}
export const key = () => crypto.randomUUID();
