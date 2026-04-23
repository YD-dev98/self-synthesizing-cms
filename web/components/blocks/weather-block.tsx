"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface WeatherBlockProps {
  title: string;
  content: {
    temperature?: number;
    unit?: string;
    condition?: string;
    location?: string;
  };
}

export function WeatherBlock({ title, content }: WeatherBlockProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Weather</Badge>
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          {content.temperature != null && (
            <span className="text-4xl font-light">
              {content.temperature}°{content.unit ?? "C"}
            </span>
          )}
          {content.condition && (
            <span className="text-muted-foreground">{content.condition}</span>
          )}
        </div>
        {content.location && (
          <p className="mt-1 text-sm text-muted-foreground">
            {content.location}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
