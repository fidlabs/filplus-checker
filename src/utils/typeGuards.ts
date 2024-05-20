export const isNotEmpty = <TValue>(value: TValue | null | undefined): value is TValue => {
  return value !== null && value !== undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T> = new (...args: any[]) => T

export const isInstanceOf =
  <TSource, TValue extends TSource>(Type: Constructor<TValue>) =>
    (value: TSource): value is TValue => {
      return value instanceof Type
    }
