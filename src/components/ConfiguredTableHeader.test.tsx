import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfiguredTableHeader } from './ConfiguredTableHeader'
import { getProjectTableConfig, moveTableColumn } from '../domain/table-config'
import type { Project } from '../shared/models'

const project: Project = {schemaVersion:1,appVersion:'1',id:'test',name:'test',revision:0,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',categories:[{id:'materials',name:'材料费',color:'#2563eb',order:0}],expenses:[],attachments:[],invoiceAllocations:[],paymentAllocations:[],otherAllocations:[]}
describe('configured table header',()=>{
  it('preserves 14 default columns and both three-leaf groups',()=>{
    const html=renderToStaticMarkup(<table><ConfiguredTableHeader config={getProjectTableConfig(project)}/></table>)
    expect((html.match(/<col /g)||[]).length).toBe(14)
    expect((html.match(/colSpan="3"/g)||[]).length).toBe(2)
    expect(html).toContain('实际付款人');expect(html).toContain('其他附件');expect(html).toContain('col-actions')
    expect(html).not.toContain('采购信息')
  })
  it('keeps identities and valid two-level headers when a builtin is moved into a custom group',()=>{
    const config=getProjectTableConfig(project)
    config.columns.push({id:'group-report',name:'报销信息',kind:'group',visible:true})
    const moved=moveTableColumn(config,'date','group-report')
    const html=renderToStaticMarkup(<table><ConfiguredTableHeader config={moved}/></table>)
    expect(html).toContain('报销信息');expect((html.match(/>日期</g)||[]).length).toBe(1)
    expect((html.match(/<col /g)||[]).length).toBe(14)
  })
  it('gives new custom columns space alongside fixed-width builtins',()=>{
    const config=getProjectTableConfig(project)
    config.columns.push({id:'custom-n',name:'数量',kind:'input',inputType:'number'})
    const html=renderToStaticMarkup(<table><ConfiguredTableHeader config={config}/></table>)
    expect(html).toContain('width:160px')
  })
})
