import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_COLORS } from '@/lib/charts/build-chart';
import type { ChartData, ChartType } from '@/lib/charts/types';

export function ChartView({ data, type, stacked = false, showValues = false, compact = false }: { data: ChartData; type: ChartType; stacked?: boolean; showValues?: boolean; compact?: boolean }) {
	const rows: Array<Record<string, string | number>>=data.categories.map(c=>({name:c.label,...Object.fromEntries(data.series.map((s,i)=>[s.id,c.values[i]??0]))})); const height=compact?120:360;
	if(type==='pie'){const pie=rows.map((row,i)=>({name:row.name,value:Number(row[data.series[0]?.id]??0),color:CHART_COLORS[i%CHART_COLORS.length]}));return <ResponsiveContainer width="100%" height={height}><PieChart><Pie data={pie} dataKey="value" nameKey="name" outerRadius="80%" label={showValues}>{pie.map((entry)=><Cell key={entry.name} fill={entry.color}/>)}</Pie><Tooltip/><Legend/></PieChart></ResponsiveContainer>}
	const common={data:rows,margin:{top:12,right:16,left:0,bottom:12}}; const axes=<><CartesianGrid strokeDasharray="3 3" opacity={0.25}/><XAxis dataKey="name" hide={compact}/><YAxis hide={compact}/><Tooltip/><Legend wrapperStyle={compact?{display:'none'}:{}}/></>;
	if(type==='line')return <ResponsiveContainer width="100%" height={height}><LineChart {...common}>{axes}{data.series.map((s,i)=><Line key={s.id} dataKey={s.id} name={s.label} stroke={CHART_COLORS[i%CHART_COLORS.length]} strokeWidth={2} dot={!compact}/>)}</LineChart></ResponsiveContainer>;
	if(type==='area')return <ResponsiveContainer width="100%" height={height}><AreaChart {...common}>{axes}{data.series.map((s,i)=><Area key={s.id} dataKey={s.id} name={s.label} fill={CHART_COLORS[i%CHART_COLORS.length]} stroke={CHART_COLORS[i%CHART_COLORS.length]} fillOpacity={0.3} stackId={stacked?'a':undefined}/>)}</AreaChart></ResponsiveContainer>;
	return <ResponsiveContainer width="100%" height={height}><BarChart {...common} layout={type==='horizontal-bar'?'vertical':'horizontal'}>{axes}{data.series.map((s,i)=><Bar key={s.id} dataKey={s.id} name={s.label} fill={CHART_COLORS[i%CHART_COLORS.length]} stackId={stacked?'a':undefined} label={showValues}/>)}</BarChart></ResponsiveContainer>;
}
