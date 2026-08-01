let _t0 = 0;

export const searchPerf = {
  start: () => {
    if (typeof performance !== "undefined") _t0 = performance.now();
  },
  counter: (): string => {
    if (!_t0 || typeof performance === "undefined") return "?";
    return (performance.now() - _t0).toFixed(1);
  },
};
