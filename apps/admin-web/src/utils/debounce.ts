/** 通用防抖（不引入额外依赖） */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait = 400,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}
