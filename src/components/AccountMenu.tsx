/**
 * The account menu in the app header.
 *
 * It replaces a bare "Sign out" button. That button was the only trace of the
 * signed-in person anywhere in the shell: no name, no photo, and — more
 * awkwardly — no way to reach your own settings, because there were none. It
 * also meant the single most destructive control in the header was a
 * permanently visible one-click affordance sitting beside Search.
 *
 * Now the avatar is the anchor. Your name and the address you sign in with are
 * at the top, because "which account am I in" is the question this control is
 * asked most often — particularly by anyone who runs an office login and a
 * personal one.
 */
import { Link } from "@tanstack/react-router";
import { LogOut, User as UserIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/UserAvatar";
import { useMyProfile } from "@/hooks/useMyProfile";

export function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const { staff, authEmail } = useMyProfile();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // The avatar is 32px and stays 32px — it is the thing you recognise,
        // and growing it would change the header's look on every screen. The
        // BUTTON around it takes the touch size instead, which is the pattern
        // ui/dialog.tsx and ui/sheet.tsx already use: a small glyph centred in
        // a target a thumb can hit. It was a 32px control on every iPad.
        className="flex items-center justify-center rounded-full ring-offset-background transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 touch:min-h-11 touch:min-w-11"
      >
        {/* Named by sr-only text, not aria-label, with the initials hidden:
            an aria-label of "Your account" over visible initials "BN" is a
            name that does not contain its own text, which voice control
            cannot match (axe label-content-name-mismatch, gaps-r2-11
            part 2). */}
        <span className="sr-only">Your account</span>
        <span aria-hidden="true" className="contents">
          <UserAvatar
            name={staff?.display_name}
            avatarPath={staff?.avatar_url}
            seed={staff?.id}
            className="h-8 w-8"
            textClassName="text-xs"
          />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <div className="px-2 py-1.5">
          <div className="truncate text-sm font-medium">
            {staff?.display_name ?? "Your account"}
          </div>
          {authEmail && (
            <div className="truncate text-xs text-muted-foreground">{authEmail}</div>
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile" className="cursor-pointer">
            <UserIcon className="mr-2 h-4 w-4 shrink-0" />
            Your account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Destructive, and now one level in rather than a bare button beside
            the search box. */}
        <DropdownMenuItem onSelect={onSignOut} className="cursor-pointer text-destructive">
          <LogOut className="mr-2 h-4 w-4 shrink-0" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
