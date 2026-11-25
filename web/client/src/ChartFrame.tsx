import React, { useLayoutEffect, useRef, useState } from 'react';

export function ChartFrame({ src, title }: { src: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();

  useLayoutEffect(() => {
    function resize(event: MessageEvent) {
      // The chart runs in a sandbox with an opaque origin. Only its own
      // window may resize its frame.
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const message = event.data;
      if (message?.type !== 'suunto-chart-height' || !Number.isSafeInteger(message.height) ||
          message.height <= 0 || message.height > 100_000) return;
      setHeight(message.height + 1); // The frame also has a one-pixel top border.
    }
    window.addEventListener('message', resize);
    return () => window.removeEventListener('message', resize);
  }, []);

  return <iframe ref={frame} className="workout-chart" title={title} src={src}
    style={{ height }} sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" />;
}
