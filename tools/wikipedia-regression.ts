import type { CorpusDocument } from "./calibration-utils";

export type WikipediaObservation = { id: string; textSha256: string; result: { status: string; phrasesSampled: number; phrasesMatched: number; errorCount: number } };
type Row = { id: string; actual: number; archiveScore: number; wikipediaMatches: number };
type Fit = { intercept: number; archiveScore: number; wikipediaMatches: number; standardErrors: { intercept: number | null; archiveScore: number | null; wikipediaMatches: number | null }; rank: 2 | 3; rSquared: number };
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

function fit(rows: Row[]): Fit {
  if (rows.length < 4) throw new Error("At least four rows are required for regression.");
  const mx = mean(rows.map((r) => r.archiveScore)); const mw = mean(rows.map((r) => r.wikipediaMatches)); const my = mean(rows.map((r) => r.actual));
  let sxx = 0; let sww = 0; let sxw = 0; let sxy = 0; let swy = 0;
  for (const row of rows) { const x = row.archiveScore - mx; const w = row.wikipediaMatches - mw; const y = row.actual - my; sxx += x*x; sww += w*w; sxw += x*w; sxy += x*y; swy += w*y; }
  if (sxx <= Number.EPSILON) throw new Error("Archive scores have no variance.");
  const determinant = sxx*sww - sxw*sxw; const fullRank = sww > Number.EPSILON && Math.abs(determinant) > Math.max(1, sxx*sww)*1e-12;
  const archiveScore = fullRank ? (sxy*sww - swy*sxw)/determinant : sxy/sxx;
  const wikipediaMatches = fullRank ? (swy*sxx - sxy*sxw)/determinant : 0;
  const intercept = my - archiveScore*mx - wikipediaMatches*mw;
  const residuals = rows.map((r) => r.actual - (intercept + archiveScore*r.archiveScore + wikipediaMatches*r.wikipediaMatches));
  const sse = residuals.reduce((sum, value) => sum + value*value, 0); const sst = rows.reduce((sum, r) => sum + (r.actual-my)**2, 0); const sigma2 = sse/Math.max(1, rows.length-(fullRank?3:2));
  let standardErrors: Fit["standardErrors"] = { intercept: null, archiveScore: null, wikipediaMatches: null };
  if (fullRank) { const vx=sigma2*sww/determinant; const vw=sigma2*sxx/determinant; const cov=-sigma2*sxw/determinant; const vi=sigma2/rows.length+mx*mx*vx+mw*mw*vw+2*mx*mw*cov; standardErrors={intercept:Math.sqrt(Math.max(0,vi)),archiveScore:Math.sqrt(Math.max(0,vx)),wikipediaMatches:Math.sqrt(Math.max(0,vw))}; }
  return { intercept, archiveScore, wikipediaMatches, standardErrors, rank: fullRank?3:2, rSquared: sst>0?1-sse/sst:0 };
}
const round=(value:number,digits=6)=>Number(value.toFixed(digits));

export function evaluateWikipediaRegression(documents: CorpusDocument[], archiveRows: Array<{id:string;actual:number;score:number}>, observations: WikipediaObservation[], rocAuc: (rows:Array<{score:number;positive:boolean}>)=>number, bootstrapAuc: (rows:Array<{score:number;positive:boolean}>)=>readonly[number,number], target=15) {
  const a=new Map(archiveRows.map(r=>[r.id,r])); const o=new Map(observations.map(r=>[r.id,r]));
  const rows:Row[]=documents.map(document=>{const ar=a.get(document.id);const ob=o.get(document.id);if(!ar)throw new Error(`Missing archive row for ${document.id}.`);if(!ob)throw new Error(`Missing Wikipedia observation for ${document.id}.`);if(ob.textSha256!==document.provenance.sha256)throw new Error(`Stale Wikipedia observation for ${document.id}.`);if(ob.result.status!=="complete"||ob.result.errorCount!==0||ob.result.phrasesSampled!==20)throw new Error(`Incomplete Wikipedia observation for ${document.id}.`);return{id:document.id,actual:Number(document.turnitinScore),archiveScore:ar.score,wikipediaMatches:ob.result.phrasesMatched};});
  const counts=rows.map(r=>r.wikipediaMatches).sort((x,y)=>x-y); const histogram=Object.fromEntries([...new Set(counts)].map(count=>[String(count),counts.filter(v=>v===count).length]));
  const identifiable = new Set(counts).size > 1;
  const fitted=fit(rows);
  if (!identifiable) return {
    provider:"Wikipedia" as const,
    phraseCountPerDocument:20,
    sampleSize:rows.length,
    matchDistribution:{minimum:counts[0]??0,median:counts[Math.floor(counts.length/2)]??0,maximum:counts.at(-1)??0,zeroMatchDocuments:counts.filter(v=>v===0).length,nonzeroMatchDocuments:counts.filter(v=>v>0).length,histogram},
    combinedFit:{
      identifiable:false,
      reason:"Wikipedia match count has zero variance across the 60 labeled papers; its coefficient and standard error cannot be estimated.",
      formula:"predicted = intercept + archiveScoreCoefficient*archiveScore + wikipediaMatchCoefficient*wikipediaMatches",
      coefficients:{intercept:round(fitted.intercept),archiveScore:round(fitted.archiveScore),wikipediaMatches:null},
      standardErrors:{intercept:null,archiveScore:null,wikipediaMatches:null},
      rank:fitted.rank,
      rSquared:round(fitted.rSquared,4),
    },
    leaveOneOut:{evaluation:"not run because the Wikipedia predictor is unidentifiable",auc:null,aucCi95:null,perDocument:[]},
  };
  const loo=rows.map((held,i)=>{const m=fit(rows.filter((_,j)=>i!==j));return{...held,predicted:m.intercept+m.archiveScore*held.archiveScore+m.wikipediaMatches*held.wikipediaMatches};});
  const labelled=loo.map(r=>({score:r.predicted,positive:r.actual>=target})); const auc=rocAuc(labelled); const ci=bootstrapAuc(labelled);
  return {provider:"Wikipedia" as const,phraseCountPerDocument:20,sampleSize:rows.length,matchDistribution:{minimum:counts[0]??0,median:counts[Math.floor(counts.length/2)]??0,maximum:counts.at(-1)??0,zeroMatchDocuments:counts.filter(v=>v===0).length,nonzeroMatchDocuments:counts.filter(v=>v>0).length,histogram},combinedFit:{identifiable:true,formula:"predicted = intercept + archiveScoreCoefficient*archiveScore + wikipediaMatchCoefficient*wikipediaMatches",coefficients:{intercept:round(fitted.intercept),archiveScore:round(fitted.archiveScore),wikipediaMatches:round(fitted.wikipediaMatches)},standardErrors:{intercept:fitted.standardErrors.intercept===null?null:round(fitted.standardErrors.intercept),archiveScore:fitted.standardErrors.archiveScore===null?null:round(fitted.standardErrors.archiveScore),wikipediaMatches:fitted.standardErrors.wikipediaMatches===null?null:round(fitted.standardErrors.wikipediaMatches)},rank:fitted.rank,rSquared:round(fitted.rSquared,4)},leaveOneOut:{evaluation:"leave-one-out regression predictions",auc:round(auc,4),aucCi95:ci.map(v=>round(v,4)),perDocument:loo.map(r=>({...r,predicted:round(r.predicted,4)}))}};
}
