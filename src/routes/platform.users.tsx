import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listPlatformUsers } from "@/lib/platform-directory.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Users } from "lucide-react";

export const Route = createFileRoute("/platform/users")({
  component: UsersPage,
});

function UsersPage() {
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<string>("all");
  const listFn = useServerFn(listPlatformUsers);
  const q = useQuery({
    queryKey: ["platform", "users", role],
    queryFn: () => listFn({ data: { limit: 150, ...(role !== "all" ? { role: role as any } : {}) } }),
  });

  const rows = q.data?.rows ?? [];
  const filtered = search.trim()
    ? rows.filter((r) => {
        const s = search.toLowerCase();
        return (r.email ?? "").toLowerCase().includes(s) ||
          r.organizations.some((o) => o.name.toLowerCase().includes(s));
      })
    : rows;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Global directory across every tenant. Shows up to 150 users at a time.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center gap-3">
          <CardTitle className="text-base">Directory</CardTitle>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search email or org…"
              className="w-64"
            />
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
                <SelectItem value="office_manager">Office manager</SelectItem>
                <SelectItem value="dispatcher">Dispatcher</SelectItem>
                <SelectItem value="tech">Tech</SelectItem>
                <SelectItem value="platform_admin">Platform admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Organizations & role</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => (
                  <TableRow key={u.user_id}>
                    <TableCell className="font-medium">
                      {u.email ?? <code className="text-xs">{u.user_id.slice(0, 12)}</code>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {u.organizations.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No org</span>
                        ) : (
                          u.organizations.map((o) => (
                            <Link
                              key={`${o.id}-${o.role}`}
                              to="/platform/tenants/$id"
                              params={{ id: o.id }}
                              className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-accent"
                            >
                              <span>{o.name}</span>
                              <Badge variant="outline" className="text-[10px]">{o.role}</Badge>
                            </Link>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-sm">{u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}</TableCell>
                  </TableRow>
                ))}
                {!q.isLoading && filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground">No users match.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
