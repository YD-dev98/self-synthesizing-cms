"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface SummaryBlockProps {
  title: string;
  content: {
    text?: string;
  };
}

export function SummaryBlock({ title, content }: SummaryBlockProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Summary</Badge>
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {content.text && (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {content.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
