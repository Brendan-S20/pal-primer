import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Below `breakpoint` px. The default is Tailwind's `md` (48rem); pass 1024
 *  for `lg`. Whatever this answers has to agree with the CSS breakpoint of the
 *  thing it decides — `max-width: N-1` here and `width >= N` there — or the
 *  two disagree at exactly N. */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT) {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < breakpoint);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < breakpoint);
    return () => mql.removeEventListener("change", onChange);
  }, [breakpoint]);

  return !!isMobile;
}
