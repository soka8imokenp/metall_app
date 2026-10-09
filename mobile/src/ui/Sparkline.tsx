import React, { useMemo } from 'react';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

/** Гладкая линия с заливкой под ней — для главных цифр. Кривая Безье по соседним точкам. */
export function Sparkline({ data, width, height, color = '#fafafa' }: { data: number[]; width: number; height: number; color?: string }) {
  const { line, area, last } = useMemo(() => {
    if (data.length < 2 || width <= 0) return { line: '', area: '', last: [0, 0] as [number, number] };
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const padY = 6;
    const pts = data.map((v, i) => [(i / (data.length - 1)) * width, padY + (1 - (v - min) / span) * (height - padY * 2)] as [number, number]);
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const cx = (x0 + x1) / 2;
      d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    return { line: d, area: `${d} L ${width} ${height} L 0 ${height} Z`, last: pts[pts.length - 1] };
  }, [data, width, height]);

  if (!line) return null;
  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.28} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={area} fill="url(#sg)" />
      <Path d={line} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" />
      <Circle cx={last[0]} cy={last[1]} r={4} fill={color} />
      <Circle cx={last[0]} cy={last[1]} r={8} fill={color} opacity={0.2} />
    </Svg>
  );
}
