import { toast } from "sonner";
import { useLayoutEffect, useRef } from "react";

/** Follow navigation and responsive layout while the reminder is visible.
 *  Measuring the bars includes their safe-area padding and also handles the
 *  setup footer, which can wrap to two rows on a phone. Sonner adds its own
 *  normal edge gap above this clearance. */
function VerifyNoticeMessage({ message }: { message: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const notice = ref.current?.closest<HTMLElement>("[data-sonner-toast]");
    if (!notice) return;
    const update = () => {
      let clearance = 0;
      for (const bar of document.querySelectorAll<HTMLElement>(
        "[data-bottom-chrome], [data-setup-footer]",
      )) {
        resize.observe(bar);
        const rect = bar.getBoundingClientRect();
        const position = getComputedStyle(bar).position;
        if (
          (position === "fixed" || position === "sticky") &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.top < window.innerHeight
        ) {
          clearance = Math.max(clearance, window.innerHeight - rect.top);
        }
      }
      notice.style.bottom = `max(env(safe-area-inset-bottom, 0px), ${clearance}px)`;
    };
    const resize = new ResizeObserver(update);
    const changes = new MutationObserver(update);
    resize.observe(document.body);
    changes.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-keyboard"],
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);
  return <span ref={ref}>{message}</span>;
}

export function showSignupVerifyNotice(message: string) {
  return toast(<VerifyNoticeMessage message={message} />, {
    position: "bottom-center",
    duration: 5000,
    closeButton: true,
    style: {
      bottom: "env(safe-area-inset-bottom, 0px)",
    },
  });
}
