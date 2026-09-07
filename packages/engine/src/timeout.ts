/**
 * Races a promise against a plain timer. If the timer wins, we reject with
 * TimeoutError instead of waiting any longer for the original promise (which
 * may still be running; the caller is responsible for actually stopping
 * whatever was being waited on — e.g. killing the container).
 */
export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`Timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
