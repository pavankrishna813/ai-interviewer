import { Loader2 } from "lucide-react";
import { TrovenLogo } from "@/components/ui/aural-logo";

export function PreparingScreen() {
  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="sticky top-0 z-50 flex h-14 items-center border-b bg-card px-6">
          <div className="flex items-center gap-2">
            <TrovenLogo size={28} variant="full" className="h-7 w-auto" />
          </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <p className="text-lg font-medium">Preparing your interview...</p>
        <p className="text-sm text-muted-foreground">
          This will only take a moment.
        </p>
      </div>
    </div>
  );
}
