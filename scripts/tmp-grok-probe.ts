import { parseGrokSessions } from '../src/main/sessions/parsers/grok.js'
const s = await parseGrokSessions({ lightweight: true })
console.log('count', s.length)
console.log(JSON.stringify(s.slice(0,5).map(x=>({id:x.id,cwd:x.cwd,summary:x.summary,model:x.model,variant:x.variant,parentId:x.parentId,subagentType:x.subagentType,branch:x.branch,chat:String(x.originalPath||'').endsWith('chat_history.jsonl')})),null,2))
