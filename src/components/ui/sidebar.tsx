import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeft } from "lucide-react";

import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { nativeSidebarStyle } from "@/lib/native-build";
import {
  SIDEBAR_EXPANDED_FROM,
  SIDEBAR_RAIL_BELOW,
  readSidebarExpanded,
  sidebarExpanded,
  sidebarShape,
  writeSidebarExpanded,
  type SidebarDocksFrom,
} from "@/lib/sidebar-shape";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

/** Before paint, so a tablet never draws the 256px column for one frame and
 *  then snaps to the rail. useEffect on the server, where neither runs. */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

function useMediaMatch(query: string): boolean {
  const [matches, setMatches] = React.useState(false);
  useIsomorphicLayoutEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  /** Where the sidebar stops being a sheet and docks. See SidebarProvider. */
  docksFrom: SidebarDocksFrom;
  /** Docked, but below 1024px: an icon rail whose labelled panel opens over
   *  the page instead of beside it. See SidebarProvider. */
  rail: boolean;
  /** The rail's labelled panel is open over the page. */
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** The width from which the sidebar docks; below it, it is a sheet.
     *  `md` is the default and was the only answer. `lg-mouse` is for where
     *  something else is the navigation through the tablet range and on
     *  every touch screen: the tech tab bar, see useTabletTier. It docks
     *  from `lg` and only with a mouse. Both halves of the decision read
     *  this: the JS that picks sheet-or-docked and the CSS that shows the
     *  docked column. They were two separate spellings of 768 that
     *  happened to agree, and no caller could move either. */
    docksFrom?: SidebarDocksFrom;
    /** Below 1024px, dock as the icon rail with an overlay panel. Needs a
     *  `<Sidebar collapsible="icon">`; the platform console's offcanvas
     *  sidebar does not ask for it and keeps the full column. */
    railBelowLg?: boolean;
    /** Keep the docked column's expanded or collapsed choice on this device
     *  (lib/sidebar-shape.ts), in place of `defaultOpen`. The platform
     *  console's offcanvas sidebar does not ask: collapsed there is hidden. */
    rememberExpanded?: boolean;
  }
>(
  (
    {
      defaultOpen = true,
      docksFrom = "md",
      railBelowLg = false,
      rememberExpanded = false,
      open: openProp,
      onOpenChange: setOpenProp,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const belowDock = useIsMobile(docksFrom === "lg-mouse" ? 1024 : 768);
    // The CSS half spells this `lg:mouse:`; a coarse pointer never docks it.
    const coarsePointer = useMediaMatch("(pointer: coarse)");
    const [openMobile, setOpenMobile] = React.useState(false);

    // ── THE RAIL (QA row 34) ─────────────────────────────────────────────
    //
    // At 820px, an iPad in portrait, the docked sidebar took 256px of the
    // screen and left the page 564. Below 1024 it is the icon rail, and its
    // labelled panel opens OVER the page when asked for (the rail's own
    // button, the header toggle, or Cmd/Ctrl+B), so the content keeps the
    // width either way. From 1024 up it is the column, and the toggle
    // collapses it to the icons beside the page (#499; it was the rail up
    // to 1280, so an iPad in landscape could never keep the labels).
    //
    // The open state is separate from `open`. That one is the choice to
    // keep the column collapsed; an overlay opened below 1024 is a moment,
    // and closes on a route change (AppSidebar), on Escape and on a tap
    // outside it (below).
    const belowRail = useMediaMatch(`(max-width: ${SIDEBAR_RAIL_BELOW - 1}px)`);
    const shape = sidebarShape({ belowDock, coarsePointer, belowRail, docksFrom, railBelowLg });
    const isMobile = shape === "sheet";
    const rail = shape === "rail";
    const [railOpen, setRailOpen] = React.useState(false);
    React.useEffect(() => {
      if (!rail) setRailOpen(false);
    }, [rail]);
    React.useEffect(() => {
      if (!railOpen) return;
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") setRailOpen(false);
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [railOpen]);

    // This is the internal state of the sidebar.
    // We use openProp and setOpenProp for control from outside the component.
    const [_open, _setOpen] = React.useState(defaultOpen);
    // ── THE REMEMBERED CHOICE (#499) ─────────────────────────────────────
    //
    // The cookie below was written on every toggle and read by nothing, so
    // a collapsed column came back expanded on every reload. The choice is
    // read from this device in the first render: the signed-in shell is
    // client only, so there is no server render for it to disagree with.
    // With no choice yet the default follows the width, live, so turning
    // an iPad from portrait to landscape still gets the right answer.
    const [savedExpanded, setSavedExpanded] = React.useState<boolean | null>(() =>
      rememberExpanded ? readSidebarExpanded() : null,
    );
    const belowExpandedDefault = useMediaMatch(`(max-width: ${SIDEBAR_EXPANDED_FROM - 1}px)`);
    const open =
      openProp ??
      (rememberExpanded ? sidebarExpanded({ saved: savedExpanded, belowExpandedDefault }) : _open);
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === "function" ? value(open) : value;
        if (setOpenProp) {
          setOpenProp(openState);
        } else if (rememberExpanded) {
          setSavedExpanded(openState);
        } else {
          _setOpen(openState);
        }
        if (rememberExpanded) writeSidebarExpanded(openState);

        // This sets the cookie to keep the sidebar state.
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
      },
      [setOpenProp, open, rememberExpanded],
    );

    // Helper to toggle the sidebar.
    const toggleSidebar = React.useCallback(() => {
      if (isMobile) return setOpenMobile((open) => !open);
      if (rail) return setRailOpen((open) => !open);
      return setOpen((open) => !open);
    }, [isMobile, rail, setOpen, setOpenMobile]);

    // Adds a keyboard shortcut to toggle the sidebar.
    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          toggleSidebar();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [toggleSidebar]);

    // We add a state so that we can do data-state="expanded" or "collapsed".
    // This makes it easier to style the sidebar with Tailwind classes.
    const state = (rail ? railOpen : open) ? "expanded" : "collapsed";
    // How much of the screen the docked sidebar takes from the page, for the
    // things fixed to the viewport that have to start beside it (My Day's
    // NEXT UP bar). The rail's overlay never pushes the page, so on the rail
    // this is always the icon width.
    const dockedWidth =
      rail || state === "collapsed" ? "var(--sidebar-width-icon)" : "var(--sidebar-width)";

    const contextValue = React.useMemo<SidebarContextProps>(
      () => ({
        state,
        open,
        setOpen,
        isMobile,
        docksFrom,
        rail,
        railOpen,
        setRailOpen,
        openMobile,
        setOpenMobile,
        toggleSidebar,
      }),
      [
        state,
        open,
        setOpen,
        isMobile,
        docksFrom,
        rail,
        railOpen,
        openMobile,
        setOpenMobile,
        toggleSidebar,
      ],
    );

    return (
      <SidebarContext.Provider value={contextValue}>
        <TooltipProvider delayDuration={0}>
          <div
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH,
                "--sidebar-docked-width": dockedWidth,
                ...style,
              } as React.CSSProperties
            }
            className={cn(
              // The rail is 48px for a mouse and 60px on a touch screen, so
              // each icon button inside its 8px padding is a 44px target.
              "group/sidebar-wrapper flex min-h-svh w-full [--sidebar-width-icon:3rem] touch:[--sidebar-width-icon:3.75rem] has-[[data-variant=inset]]:bg-sidebar",
              className,
            )}
            ref={ref}
            {...props}
          >
            {children}
          </div>
        </TooltipProvider>
      </SidebarContext.Provider>
    );
  },
);
SidebarProvider.displayName = "SidebarProvider";

const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    side?: "left" | "right";
    variant?: "sidebar" | "floating" | "inset";
    collapsible?: "offcanvas" | "icon" | "none";
  }
>(
  (
    {
      side = "left",
      variant = "sidebar",
      collapsible = "offcanvas",
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const { isMobile, docksFrom, state, openMobile, setOpenMobile, rail, railOpen, setRailOpen } =
      useSidebar();

    if (collapsible === "none") {
      return (
        <div
          className={cn(
            "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
            className,
          )}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      );
    }

    if (isMobile) {
      return (
        <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
          <SheetContent
            data-sidebar="sidebar"
            data-mobile="true"
            /* `[&>button]:hidden` used to be here, and it hid the 44pt close
               control ui/sheet.tsx already renders. Nothing else closed this
               sheet either (see AppSidebar), so the only way out was the strip
               of dimmed page beside it. iOS QA 2026-08-25 measured that strip
               at ~114pt on a 402pt screen. The More sheet keeps its X; this one
               now matches it. */
            /* …and then the restored X landed under the camera. sheet.tsx pins
               it at `top-2`, which on a Dynamic Island phone is inside the
               cutout — reported from a real iPhone, where the lens sits over
               it. VisitDetailDrawer got this offset when it got its safe-area
               padding; this branch got the padding on its inner column and the
               button, being a direct child of SheetContent, never moved.
               env() is 0 on the web, so nothing hosted changes. */
            /* Since 2026-10-04 that offset is ui/sheet.tsx's own default for
               every sheet that reaches the top of the screen, so the override
               that lived here is gone. The padding stays on the inner column
               (nativeSidebarStyle, below) rather than on this `p-0` sheet. */
            className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground"
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
            side={side}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Displays the mobile sidebar.</SheetDescription>
            </SheetHeader>
            {/* NATIVE ONLY. The desktop branch below has carried
                nativeSidebarStyle() since the iPad fix; this branch never did,
                so on a phone the wordmark was overprinted by the clock and sat
                under the Dynamic Island, and the account row ended 8pt from
                the physical bottom — 26pt of a 44pt target inside the
                home-indicator strip. Measured on an iPhone 17 Pro, 2026-08-25.
                Applied to the inner column, not the sheet, so bg-sidebar still
                paints edge to edge behind the status bar. */}
            <div className="flex h-full w-full flex-col" style={nativeSidebarStyle()}>
              {children}
            </div>
          </SheetContent>
        </Sheet>
      );
    }

    return (
      <div
        ref={ref}
        // Both spelled out: Tailwind finds class names by scanning source,
        // and cannot see an assembled one.
        className={`group peer hidden text-sidebar-foreground ${
          docksFrom === "lg-mouse" ? "lg:mouse:block" : "md:block"
        }`}
        data-state={state}
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-variant={variant}
        data-side={side}
        data-rail={rail ? (railOpen ? "open" : "closed") : undefined}
      >
        {/* This is what handles the sidebar gap on desktop. On the rail it
            stays the rail's width while the panel is open, so the page
            under the overlay does not move. */}
        <div
          className={cn(
            "relative bg-transparent transition-[width] duration-200 ease-linear",
            "group-data-[side=right]:rotate-180",
            rail
              ? "w-(--sidebar-width-icon)"
              : cn(
                  "w-(--sidebar-width) group-data-[collapsible=offcanvas]:w-0",
                  variant === "floating" || variant === "inset"
                    ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_theme(spacing.4))]"
                    : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
                ),
          )}
        />
        {/* A tap anywhere outside the open panel closes it. Not a button:
            Escape and the panel's own close control are the keyboard way
            out, and a second focus stop over the whole page helps nobody. */}
        {rail && railOpen && (
          <div
            aria-hidden="true"
            data-sidebar="rail-backdrop"
            onClick={() => setRailOpen(false)}
            className="fixed inset-0 z-[44] bg-black/30"
          />
        )}
        <div
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear",
            docksFrom === "lg-mouse" ? "lg:mouse:flex" : "md:flex",
            // Over the header (z-30) and over My Day's NEXT UP bar and the
            // tab bar (z-40), under dialogs and sheets (z-50).
            rail && railOpen && "z-[45] shadow-xl",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
            // Adjust the padding for floating and inset variants.
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_theme(spacing.4)_+2px)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className,
          )}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            // NATIVE ONLY. The sidebar is `fixed inset-y-0`, so with
            // `ios.contentInset: "never"` it runs from the physical top of the
            // screen to the physical bottom: the wordmark sat under the clock
            // and the account row sat in the home-indicator strip, on every
            // iPad screen. Padding the inner column moves the CONTENTS while
            // `bg-sidebar` still paints the full height behind them.
            style={nativeSidebarStyle()}
            className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow"
          >
            {children}
          </div>
        </div>
      </div>
    );
  },
);
Sidebar.displayName = "Sidebar";

const SidebarTrigger = React.forwardRef<
  React.ElementRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      ref={ref}
      data-sidebar="trigger"
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7", className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
});
SidebarTrigger.displayName = "SidebarTrigger";

const SidebarRail = React.forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
  ({ className, ...props }, ref) => {
    const { toggleSidebar } = useSidebar();

    return (
      <button
        ref={ref}
        data-sidebar="rail"
        aria-label="Toggle Sidebar"
        tabIndex={-1}
        onClick={toggleSidebar}
        title="Toggle Sidebar"
        className={cn(
          "absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex",
          "[[data-side=left]_&]:cursor-w-resize [[data-side=right]_&]:cursor-e-resize",
          "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
          "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full group-data-[collapsible=offcanvas]:hover:bg-sidebar",
          "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
          "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
          className,
        )}
        {...props}
      />
    );
  },
);
SidebarRail.displayName = "SidebarRail";

const SidebarInset = React.forwardRef<HTMLDivElement, React.ComponentProps<"main">>(
  ({ className, ...props }, ref) => {
    return (
      <main
        ref={ref}
        className={cn(
          "relative flex w-full flex-1 flex-col bg-background",
          "md:peer-data-[variant=inset]:m-2 md:peer-data-[state=collapsed]:peer-data-[variant=inset]:ms-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow",
          className,
        )}
        {...props}
      />
    );
  },
);
SidebarInset.displayName = "SidebarInset";

const SidebarInput = React.forwardRef<
  React.ElementRef<typeof Input>,
  React.ComponentProps<typeof Input>
>(({ className, ...props }, ref) => {
  return (
    <Input
      ref={ref}
      data-sidebar="input"
      className={cn(
        "h-8 w-full bg-background shadow-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        className,
      )}
      {...props}
    />
  );
});
SidebarInput.displayName = "SidebarInput";

const SidebarHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="header"
        className={cn("flex flex-col gap-2 p-2", className)}
        {...props}
      />
    );
  },
);
SidebarHeader.displayName = "SidebarHeader";

const SidebarFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="footer"
        className={cn("flex flex-col gap-2 p-2", className)}
        {...props}
      />
    );
  },
);
SidebarFooter.displayName = "SidebarFooter";

const SidebarSeparator = React.forwardRef<
  React.ElementRef<typeof Separator>,
  React.ComponentProps<typeof Separator>
>(({ className, ...props }, ref) => {
  return (
    <Separator
      ref={ref}
      data-sidebar="separator"
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      {...props}
    />
  );
});
SidebarSeparator.displayName = "SidebarSeparator";

const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="content"
        className={cn(
          // The rail scrolls too. It was `overflow-hidden` once collapsed,
          // which was fine while collapsing was a desktop choice; as the
          // tablet's rail, twenty-odd 44px icons are taller than an iPad in
          // landscape, and the ones below the fold could not be reached.
          // No visible scrollbar in a 48px column.
          "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden group-data-[collapsible=icon]:[scrollbar-width:none]",
          className,
        )}
        {...props}
      />
    );
  },
);
SidebarContent.displayName = "SidebarContent";

const SidebarGroup = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-sidebar="group"
        className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
        {...props}
      />
    );
  },
);
SidebarGroup.displayName = "SidebarGroup";

const SidebarGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & { asChild?: boolean }
>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      ref={ref}
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className,
      )}
      {...props}
    />
  );
});
SidebarGroupLabel.displayName = "SidebarGroupLabel";

const SidebarGroupAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { asChild?: boolean }
>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      ref={ref}
      data-sidebar="group-action"
      className={cn(
        "absolute end-3 top-3.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-none ring-sidebar-ring cursor-pointer transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 after:md:hidden",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
});
SidebarGroupAction.displayName = "SidebarGroupAction";

const SidebarGroupContent = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  ),
);
SidebarGroupContent.displayName = "SidebarGroupContent";

const SidebarMenu = React.forwardRef<HTMLUListElement, React.ComponentProps<"ul">>(
  ({ className, ...props }, ref) => (
    <ul
      ref={ref}
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  ),
);
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.ComponentProps<"li">>(
  ({ className, ...props }, ref) => (
    <li
      ref={ref}
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  ),
);
SidebarMenuItem.displayName = "SidebarMenuItem";

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-start text-sm outline-none ring-sidebar-ring cursor-pointer transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed group-has-[[data-sidebar=menu-action]]/menu-item:pe-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 group-data-[collapsible=icon]:justify-center touch:group-data-[collapsible=icon]:!size-11 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
      },
      size: {
        // `touch:min-h-11` — the whole left navigation was a 32px target on
        // every iPad. The sidebar is `hidden` below `md`, so nothing about
        // this was ever visible to a phone-width sweep, and `max-md:` sizing
        // could not have reached it either: the component does not exist at
        // the widths that rule covers. It is the app's primary navigation and
        // it was under the floor on every touch device that can see it.
        //
        // `min-h` rather than `h`, so the collapsed icon rail's
        // `group-data-[collapsible=icon]:!size-8` keeps its square width while
        // the row still takes a finger. Since the rail became the tablet's
        // navigation (QA row 34) the square itself is 44px on a touch screen,
        // `touch:…:!size-11` in the base classes above, and the rail is wide
        // enough to hold it (SidebarProvider).
        default: "h-8 text-sm touch:min-h-11",
        sm: "h-7 text-xs touch:min-h-11",
        lg: "h-12 text-sm group-data-[collapsible=icon]:!p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean;
    isActive?: boolean;
    tooltip?: string | React.ComponentProps<typeof TooltipContent>;
  } & VariantProps<typeof sidebarMenuButtonVariants>
>(
  (
    {
      asChild = false,
      isActive = false,
      variant = "default",
      size = "default",
      tooltip,
      className,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const { isMobile, state } = useSidebar();

    const button = (
      <Comp
        ref={ref}
        data-sidebar="menu-button"
        data-size={size}
        data-active={isActive}
        className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
        {...props}
      />
    );

    if (!tooltip) {
      return button;
    }

    if (typeof tooltip === "string") {
      tooltip = {
        children: tooltip,
      };
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent
          side="right"
          align="center"
          hidden={state !== "collapsed" || isMobile}
          {...tooltip}
        />
      </Tooltip>
    );
  },
);
SidebarMenuButton.displayName = "SidebarMenuButton";

const SidebarMenuAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean;
    showOnHover?: boolean;
  }
>(({ className, asChild = false, showOnHover = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-action"
      className={cn(
        "absolute end-1 top-1.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-none ring-sidebar-ring cursor-pointer transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0",
        // Increases the hit area of the button on mobile.
        "after:absolute after:-inset-2 after:md:hidden",
        "peer-data-[size=sm]/menu-button:top-1",
        "peer-data-[size=default]/menu-button:top-1.5",
        "peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground md:opacity-0",
        className,
      )}
      {...props}
    />
  );
});
SidebarMenuAction.displayName = "SidebarMenuAction";

const SidebarMenuBadge = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute end-1 flex h-5 min-w-5 select-none items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums text-sidebar-foreground",
        "peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground",
        "peer-data-[size=sm]/menu-button:top-1",
        "peer-data-[size=default]/menu-button:top-1.5",
        "peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  ),
);
SidebarMenuBadge.displayName = "SidebarMenuBadge";

const SidebarMenuSkeleton = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    showIcon?: boolean;
  }
>(({ className, showIcon = false, ...props }, ref) => {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  }, []);

  return (
    <div
      ref={ref}
      data-sidebar="menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  );
});
SidebarMenuSkeleton.displayName = "SidebarMenuSkeleton";

const SidebarMenuSub = React.forwardRef<HTMLUListElement, React.ComponentProps<"ul">>(
  ({ className, ...props }, ref) => (
    <ul
      ref={ref}
      data-sidebar="menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-s border-sidebar-border px-2.5 py-0.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  ),
);
SidebarMenuSub.displayName = "SidebarMenuSub";

const SidebarMenuSubItem = React.forwardRef<HTMLLIElement, React.ComponentProps<"li">>(
  ({ ...props }, ref) => <li ref={ref} {...props} />,
);
SidebarMenuSubItem.displayName = "SidebarMenuSubItem";

const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<"a"> & {
    asChild?: boolean;
    size?: "sm" | "md";
    isActive?: boolean;
  }
>(({ asChild = false, size = "md", isActive, className, ...props }, ref) => {
  const Comp = asChild ? Slot : "a";

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-none ring-sidebar-ring cursor-pointer hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
        "data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
        size === "sm" && "text-xs",
        size === "md" && "text-sm",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
});
SidebarMenuSubButton.displayName = "SidebarMenuSubButton";

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
