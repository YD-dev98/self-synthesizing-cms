"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface TrendsBlockProps {
  title: string;
  content: {
    items?: Array<{
      text?: string;
      url?: string;
      source?: string;
    }>;
    summary?: string;
  };
}

export function TrendsBlock({ title, content }: TrendsBlockProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Trends</Badge>
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {content.summary && (
          <p className="text-sm text-muted-foreground">{content.summary}</p>
        )}
        {content.items && content.items.length > 0 && (
          <>
            {content.summary && <Separator />}
            <ul className="space-y-2">
              {content.items.map((item, i) => (
                <li key={i} className="text-sm">
                  {item.url ? (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      {item.text ?? item.url}
                    </a>
                  ) : (
                    <span>{item.text}</span>
                  )}
                  {item.source && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      — {item.source}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
