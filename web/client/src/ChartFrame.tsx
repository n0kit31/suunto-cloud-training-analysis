import React, { useLayoutEffect, useRef, useState } from 'react';

export function ChartFrame({ src, title, onCursor }: {
  src: string; title: string; onCursor: (time: number | null) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    function receive(event: MessageEvent) {
      // The sandboxed chart has an opaque origin. Require its exact window.
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const message = event.data;
      if (message?.type === 'suunto-chart-cursor') {
        const time = message.time;
        if (time === null || (Number.isFinite(time) && time >= 0)) onCursor(time);
        return;
      }
      if (message?.type !== 'suunto-chart-height' || !Number.isSafeInteger(message.height) ||
          message.height <= 0 || message.height > 100_000) return;
      setHeight(message.height + 1); // The frame also has a one-pixel top border.
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onCursor]);

  return <iframe ref={frame} className="workout-chart" title={title} src={src}
    style={{ height }} sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" />;
}
