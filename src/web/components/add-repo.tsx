import { GithubLogo, Plus } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button, Input, Spinner } from "./ui";

export function AddRepoForm({ autoFocus }: { autoFocus?: boolean }) {
  const [value, setValue] = useState("");
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () => api.addRepo(value),
    onSuccess: (repo) => {
      setValue("");
      qc.invalidateQueries();
      if (repo.scanError) toast.warning(`${repo.fullName}: ${repo.scanError}`);
      else
        toast.success(
          `${repo.fullName}: ${repo.depCount} dependencies across ${repo.lockfiles.length} lockfile${repo.lockfiles.length === 1 ? "" : "s"}${repo.exposureCount ? `, ${repo.exposureCount} exposure${repo.exposureCount === 1 ? "" : "s"} found` : ", nothing exposed"}`,
        );
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <form
      className="flex w-full max-w-md gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) add.mutate();
      }}
    >
      <div className="relative flex-1">
        <GithubLogo className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus={autoFocus} value={value} onChange={(e) => setValue(e.target.value)} placeholder="owner/repo" className="bg-card pl-8 font-mono" aria-label="GitHub repository" />
      </div>
      <Button type="submit" disabled={add.isPending || !value.trim()}>
        {add.isPending ? <Spinner /> : <Plus weight="bold" />} {add.isPending ? "Scanning" : "Watch repo"}
      </Button>
    </form>
  );
}
