"use client";

import Link from "next/link";
import { TrovenLogo } from "@/components/ui/aural-logo";
import { DocsSearch } from "./docs-search";
import { ExternalLink } from "lucide-react";

export function DocsHeader() {
  return (
    <header className="sticky top-0 z-50 bg-mk-bg/80 backdrop-blur-md border-b border-mk-border/40">
      <div className="flex items-center gap-6 px-6 py-3">
        <Link
          href="/docs"
          className="flex items-center gap-2 shrink-0 group"
        >
          <TrovenLogo
            size={28}
            variant="full"
            className="h-7 w-auto transition-transform duration-300 group-hover:scale-105"
          />
        </Link>

        <div className="flex-1 max-w-lg mx-auto">
          <DocsSearch compact />
        </div>

        <nav className="hidden md:flex items-center gap-5 shrink-0">
          <Link
            href="/"
            target="_blank"
            className="flex items-center gap-1 text-xs font-medium text-mk-text-secondary hover:text-mk-text transition-colors"
          >
            Home
            <ExternalLink className="h-3 w-3" />
          </Link>
          <Link
            href="/login"
            className="bg-mk-dark text-mk-text-light text-xs font-semibold px-4 py-2 rounded-lg hover:bg-mk-dark/80 transition-all duration-200"
          >
            Sign In
          </Link>
        </nav>
      </div>
    </header>
  );
}
