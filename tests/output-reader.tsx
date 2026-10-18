import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { OutputReader } from '../src/components/terminal/OutputReader';
import type { OutputItem, SessionRecord } from '../src/api/types';
import '../src/styles.css';
import 'material-symbols/outlined.css';
const text = '# 终端输出阅读面板实施计划\n\n让长计划拥有独立的阅读空间。右上角保留简洁的内容目录，阅读时终端继续工作。\n\n## 一、交互设计\n\n- 点击输出标题，在右侧展开完整内容。\n- 切换文档后保留各自的阅读位置。\n- 新输出只更新目录，不打断当前阅读。\n\n| 阶段 | 内容 | 验收标准 |\n| --- | --- | --- |\n| 数据读取 | 从会话记录读取 Markdown 文件 | 不混入终端重绘残留 |\n| 阅读体验 | Markdown、表格、代码 | 长内容可独立滚动 |\n| 更新处理 | 保留选中的文档 | 阅读位置不跳动 |\n\n## 二、接口示例\n\n```typescript\ninterface OutputItem {\n  id: string;\n  title: string;\n  markdown: string;\n}\nconst reader = { preservePosition: true };\n```\n\n> 阅读面板展示当前会话内容。\n\n' + Array.from({length:16}, (_,i)=>`## ${i+3}、验证步骤\n\n这是第 ${i+1} 项长内容验证。滚动到这里后，点击“模拟新增文档”，阅读位置应保持不变。**标题、表格和正文都应清晰易读。**\n\n`).join('') + '\n![不自动加载的远程图片](https://example.invalid/image.png)\n<script>alert("unsafe")</script>\n[不执行](javascript:alert(1))';
const output = (id: string, title: string, markdown: string, kind: OutputItem['kind'] = 'document'): OutputItem => ({ id, title, markdown, kind, filePath: `/workspace/docs/${id}.md`, timestamp: '2026-10-18T14:15:00Z', truncated: false, revision:id });
let entries = [output('plan','终端输出阅读面板实施计划',text,'plan'),output('review','跨层检查与回归验证','# 跨层检查与回归验证\n\n读取链路、会话归属与阅读体验均已检查。'),output('implementation','当前实现说明','# 当前实现说明\n\n计划和实现文档可以独立阅读。')];
let revision = 1;
const alternateEntries = [output('other-document', '另一个会话的独立文档', '# 另一个会话的独立文档\n\n这里没有主会话的计划和验证结果。')];
const load = async (id: string, known?: string|null) => ({ conversationId:id==='other'?'fixture-other':'fixture',status:'ready' as const,revision:String(revision),items:known===String(revision)?null:id==='other'?alternateEntries:entries,limited:false });
const session:SessionRecord = { id:'output-reader-qa',container:'claude-01',title:'终端阅读体验改进',cwd:'/workspace',mode:'claude',args:[],env:[],tmux:true,createdAt:0 };
function Fixture() {
  const [alternate,setAlternate]=useState(false);
  return <main style={{height:'100vh',position:'relative',background:'#121720',padding:28}}>
    <h1 style={{fontSize:20,color:'#dce6f2'}}>Claude 终端 · 输出阅读验证</h1>
    <p style={{marginTop:16,color:'#899aac'}}>终端持续运行；右上角目录和右侧面板独立于终端尺寸。</p>
    <button style={{marginTop:30,padding:'10px 16px',background:'#254157',borderRadius:8}} onClick={()=>{revision++;entries=[output('new'+revision,'新的实现文档 '+revision,'# 新的实现文档\n\n当前阅读位置应该保持不变。'),...entries]}}>模拟新增文档</button>
    <button style={{margin:12,padding:'10px 16px',background:'#254157',borderRadius:8}} onClick={()=>setAlternate(v=>!v)}>切换测试会话</button>
    <pre style={{marginTop:30,color:'#a7bbcd',lineHeight:2}}>❯ 检查终端输出与阅读面板{'\n\n'}● 已准备输出内容。可以继续输入其他任务。{'\n\n'}  工具执行与阅读互不干扰。</pre>
    <OutputReader key={alternate?'other':session.id} session={alternate?{...session,id:'other',title:'另一个会话'}:session} load={load} />
  </main>;
}
const root=createRoot(document.getElementById('root')!);root.render(<Fixture/>);import.meta.hot?.dispose(()=>root.unmount());
