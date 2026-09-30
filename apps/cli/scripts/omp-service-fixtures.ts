/** External protocol substitutes only. OMP and the Lody client remain real. */
export const framedService = String.raw`
import {appendFileSync} from 'node:fs';
let buffer=Buffer.alloc(0);
const send=(message)=>{const body=Buffer.from(JSON.stringify(message));process.stdout.write('Content-Length: '+body.length+'\r\n\r\n');process.stdout.write(body);};
process.stdin.on('data',(chunk)=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(true){
    const boundary=buffer.indexOf('\r\n\r\n');if(boundary<0)return;
    const length=Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,boundary).toString())?.[1]);
    if(!Number.isFinite(length))throw new Error('Invalid frame');
    const start=boundary+4;if(buffer.length<start+length)return;
    const message=JSON.parse(buffer.subarray(start,start+length).toString());buffer=buffer.subarray(start+length);
    appendFileSync(process.argv[2],JSON.stringify({method:message.method??message.command})+'\n');
    handle(message);
  }
});
`;

export const lspService =
  framedService +
  String.raw`
let uri;
const range={start:{line:0,character:6},end:{line:0,character:14}};
function handle(message){
  const {id,method,params}=message;
  if(method==='textDocument/didOpen'||method==='textDocument/didChange'){
    uri=params.textDocument.uri;
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version:params.textDocument.version,diagnostics:[{range,severity:2,source:'baseline',message:'LSP_DIAGNOSTIC_SENTINEL'}]}});
  }
  if(id===undefined)return;
  let result=null;
  if(method==='initialize')result={capabilities:{textDocumentSync:2,definitionProvider:true,renameProvider:true}};
  if(method==='textDocument/definition')result=[{uri:params.textDocument.uri,range}];
  if(method==='textDocument/rename')result={changes:{[params.textDocument.uri]:[{range,newText:params.newName}]}};
  send({jsonrpc:'2.0',id,result});
}
`;

export const dapService =
  framedService +
  String.raw`
let seq=1;let sourcePath;let stepped=false;
const event=(event,body={})=>send({seq:seq++,type:'event',event,body});
function handle(message){
  const {command,arguments:args={}}=message;
  let body={};
  if(command==='initialize')body={supportsConfigurationDoneRequest:true,supportsTerminateRequest:true};
  if(command==='launch')sourcePath=args.program;
  if(command==='threads')body={threads:[{id:1,name:'baseline-thread'}]};
  if(command==='stackTrace')body={stackFrames:[{id:10,name:stepped?'DAP_STEP_SENTINEL':'baseline-frame',line:stepped?2:1,column:1,source:{name:'debug.ts',path:sourcePath}}],totalFrames:1};
  if(command==='scopes')body={scopes:[{name:'Locals',variablesReference:20,expensive:false}]};
  if(command==='variables')body={variables:[{name:'baselineValue',value:'DAP_VARIABLE_SENTINEL',variablesReference:0}]};
  if(command==='next')stepped=true;
  send({seq:seq++,type:'response',request_seq:message.seq,success:true,command,body});
  if(command==='launch')event('initialized');
  if(command==='configurationDone'||command==='next')event('stopped',{reason:command==='next'?'step':'entry',threadId:1,allThreadsStopped:true});
  if(command==='terminate')event('terminated');
}
`;

export function syntheticPdf(): Buffer {
  const stream = 'BT /F1 12 Tf 30 100 Td (PDF_CONTENT_SENTINEL) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += index + 1 + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    'xref\n0 ' +
    (objects.length + 1) +
    '\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
      .join('');
  pdf +=
    'trailer\n<< /Size ' +
    (objects.length + 1) +
    ' /Root 1 0 R >>\nstartxref\n' +
    xref +
    '\n%%EOF\n';
  return Buffer.from(pdf);
}

export const githubService = String.raw`
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(process.env.BASELINE_GH_REQUESTS,JSON.stringify(args)+'\n');
const common={number:1,url:'https://github.com/baseline/repo/pull/1',state:'OPEN',body:'Synthetic fixture body',author:{login:'baseline'},comments:[],labels:[],assignees:[],createdAt:'2026-09-29T00:00:00Z',updatedAt:'2026-09-29T00:00:00Z'};
let result;
if(args[0]==='pr'&&args[1]==='view')result={...common,title:'GITHUB_PR_SENTINEL',isDraft:false,baseRefName:'main',headRefName:'fixture',files:[],reviews:[],statusCheckRollup:[],commits:[],mergeable:'MERGEABLE'};
else if(args[0]==='issue'&&args[1]==='view')result={...common,title:'GITHUB_ISSUE_SENTINEL',url:'https://github.com/baseline/repo/issues/1'};
else if(args[0]==='repo'&&args[1]==='view')result={nameWithOwner:'baseline/repo',description:'GITHUB_TOOL_SENTINEL',url:'https://github.com/baseline/repo',defaultBranchRef:{name:'main'},isPrivate:false,repositoryTopics:[],stargazerCount:0,forkCount:0};
else if(args[0]==='api'&&args.some((arg)=>arg.endsWith('/comments')))result=[];
else if(args[0]==='--version'){console.log('gh version 2.0.0 (synthetic)');process.exit(0);}
else {console.error('Unexpected synthetic gh operation');process.exit(1);}
console.log(JSON.stringify(result));
`;
/** A private native window; desktop acceptance never targets the user's apps. */
export const desktopWindowService = `import Cocoa
final class BaselineController: NSObject {
  let resultPath: String
  let label = NSTextField(labelWithString: "COMPUTER_ORIGINAL_SENTINEL")
  init(_ resultPath: String) { self.resultPath = resultPath; super.init() }
  @objc func change(_ sender: Any?) {
    label.stringValue = "COMPUTER_INPUT_SENTINEL"
    try! "COMPUTER_INPUT_SENTINEL".write(toFile: resultPath, atomically: true, encoding: .utf8)
    FileHandle.standardOutput.write(Data("changed\\n".utf8))
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = BaselineController(CommandLine.arguments[1])
let window = NSPanel(contentRect: NSRect(x: 80, y: 80, width: 360, height: 180),
  styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
window.title = "OMP_COMPUTER_WINDOW_SENTINEL"
window.isFloatingPanel = false
window.hidesOnDeactivate = false
let content = window.contentView!
controller.label.frame = NSRect(x: 20, y: 100, width: 320, height: 30)
content.addSubview(controller.label)
let button = NSButton(title: "Baseline change", target: controller, action: #selector(BaselineController.change(_:)))
button.frame = NSRect(x: 20, y: 30, width: 200, height: 40)
content.addSubview(button)
window.orderFrontRegardless()
FileHandle.standardOutput.write(Data("ready\\n".utf8))
app.run()
`;

/** Valid PCM16 WAV bytes returned by the controlled speech service. */
export function syntheticWave() {
  const audio = Buffer.alloc(48);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(40, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(4, 40);
  audio.writeInt16LE(128, 44);
  audio.writeInt16LE(-128, 46);
  return audio;
}
