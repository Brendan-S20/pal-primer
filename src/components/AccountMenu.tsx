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
        aria-label="Your account"
        className="rounded-full ring-offset-background transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <UserAvatar
          name={staff?.display_name}
          avatarPath={staff?.avatar_url}
          seed={staff?.id}
          className="h-8 w-8"
          textClassName="text-xs"
        />
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
            <UserIcon className="mr-2 h-4 w-4" />
            Your account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Destructive, and now one level in rather than a bare button beside
            the search box. */}
        <DropdownMenuItem onSelect={onSignOut} className="cursor-pointer text-destructive">
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
