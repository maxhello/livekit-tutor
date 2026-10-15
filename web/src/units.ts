/**
 * 多邻国单元数据:打开页面时从个人站点仓库(maxhello.github.io)实时读两个 raw 文件。
 * - duolingo-history.json:每日快照,当前单元 = 最新一份带 score.lastUnitDone 的快照 + 1
 * - duolingo-guidebooks.json:每个单元的目标、关键句、语法点(多邻国 App 里的「指南」)
 * 算法与站点 src/pages/Learn.tsx / src/components/UnitGuide.tsx 保持一致。
 * raw.githubusercontent.com 允许跨域、gzip 后约 84KB、CDN 缓存 5 分钟。
 */

const RAW_BASE = 'https://raw.githubusercontent.com/maxhello/maxhello.github.io/main/data'

/** 指南数据结构(与站点 src/components/UnitGuide.tsx 一致);tts 是读音地址(哈希,或完整 URL) */
export type GuideWord = { w: string; hints: string[]; tts: string }
export type GuideSentence = { en: string; zh: string; tts: string; words: GuideWord[] }
export type GuideBlock = {
  type: 'text' | 'example' | 'table'
  text?: string
  en?: string
  zh?: string
  tts?: string
  rows?: string[][]
}

export type GuideUnit = {
  unitIndex: number
  section: number
  unitInSection: number
  cefr: string | null
  objective: string
  keySentences: GuideSentence[]
  grammar: { title: string; blocks: GuideBlock[] }[]
}

type HistoryLite = { days: { score?: { lastUnitDone?: number } }[] }
type GuideFile = { ttsBase: string; units: GuideUnit[] }

/** 传给后端 /api/token 的单元练习材料(后端限长,原样转给 Emma) */
export type UnitBrief = {
  index: number
  label: string
  objective: string
  sentences: { en: string; zh: string }[]
  grammar: { title: string; examples: string[] }[]
}

export type UnitData = {
  /** 正在学的单元(unitIndex,0-based 全局编号) */
  current: number
  /** 读音 mp3 的公共前缀(文件里多数只存哈希) */
  ttsBase: string
  /** 可以练的单元:已完成 + 当前,且有指南缓存;新→旧 */
  units: GuideUnit[]
}

/** App 里的叫法:第 N 阶段 · 第 M 部分 */
export function unitLabel(u: GuideUnit): string {
  return `第 ${u.section + 1} 阶段 · 第 ${u.unitInSection} 部分`
}

/** 指南文本里的 **粗体** 标记去掉 */
const plain = (s: string) => s.replace(/\*\*/g, '').trim()

/** 一个单元精简成练习材料:关键句最多 10 条,语法点最多 3 个、各 3 个例句 */
export function unitBrief(u: GuideUnit): UnitBrief {
  return {
    index: u.unitIndex,
    label: `${unitLabel(u)} · ${plain(u.objective)}`.slice(0, 60), // 历史记录里显示
    objective: plain(u.objective).slice(0, 200),
    sentences: u.keySentences.slice(0, 10).map((s) => ({
      en: plain(s.en).slice(0, 200),
      zh: plain(s.zh ?? '').slice(0, 200),
    })),
    grammar: u.grammar.slice(0, 3).map((g) => ({
      title: plain(g.title).slice(0, 200),
      examples: g.blocks
        .flatMap((b) => (b.type === 'example' && b.en ? [plain(b.en).slice(0, 200)] : []))
        .slice(0, 3),
    })),
  }
}

let cache: Promise<UnitData> | null = null

/** 读进度 + 指南(同一页面只读一次);失败时 reject,调用方隐藏单元卡片 */
export function loadUnits(): Promise<UnitData> {
  cache ??= Promise.all([
    fetch(`${RAW_BASE}/duolingo-history.json`).then((r) => {
      if (!r.ok) throw new Error(`history ${r.status}`)
      return r.json() as Promise<HistoryLite>
    }),
    fetch(`${RAW_BASE}/duolingo-guidebooks.json`).then((r) => {
      if (!r.ok) throw new Error(`guidebooks ${r.status}`)
      return r.json() as Promise<GuideFile>
    }),
  ])
    .then(([history, guide]) => {
      const lastUnitDone =
        [...history.days].reverse().find((d) => d.score?.lastUnitDone != null)?.score
          ?.lastUnitDone ?? -1
      const current = lastUnitDone + 1
      const units = guide.units
        .filter((u) => u.unitIndex <= current && u.keySentences.length > 0)
        .sort((a, b) => b.unitIndex - a.unitIndex)
      return { current, ttsBase: guide.ttsBase, units }
    })
    .catch((e) => {
      cache = null // 下次打开再试
      throw e
    })
  return cache
}

/** 读音地址:多数是哈希(拼公共前缀),少数本身就是完整 URL */
export const ttsUrl = (base: string, tts: string | undefined) =>
  !tts ? '' : /^https?:\/\//.test(tts) ? tts : base + tts
