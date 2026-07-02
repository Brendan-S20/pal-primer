import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { setLanguage, currentLanguage } from "@/lib/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export function LanguageToggle({ variant = "ghost" }: { variant?: "ghost" | "outline" }) {
  const { t, i18n } = useTranslation();
  const lang = currentLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size="sm" className="gap-1.5" aria-label={t("common.language")}>
          <Languages className="h-4 w-4" />
          <span className="text-xs font-medium uppercase">{lang}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            setLanguage("en");
            i18n.changeLanguage("en");
          }}
        >
          {t("common.english")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setLanguage("es");
            i18n.changeLanguage("es");
          }}
        >
          {t("common.spanish")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
