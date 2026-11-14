import { Compass } from "@phosphor-icons/react";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { Shell } from "@/components/shell";
import { buttonVariants, Card, Empty } from "@/components/ui";

export const Route = createRootRoute({
  component: () => (
    <Shell>
      <Outlet />
      <Toaster
        position="bottom-right"
        toastOptions={{ className: "!rounded-lg !border !border-border !bg-popover !text-popover-foreground !shadow-lg !font-sans" }}
      />
    </Shell>
  ),
  notFoundComponent: () => (
    <Card className="mx-auto mt-16 max-w-xl">
      <Empty
        icon={<Compass />}
        title="Page not found"
        action={
          <Link to="/" className={buttonVariants({ variant: "outline" })}>
            Back to overview
          </Link>
        }
      >
        This link doesn't point at anything Firebreak knows about.
      </Empty>
    </Card>
  ),
});
