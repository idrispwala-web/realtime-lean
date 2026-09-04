import json,sys,os
def analyze(path):
    turns=0; calls=[]; results={}
    for line in open(path,encoding='utf-8'):
        line=line.strip()
        if not line: continue
        try: m=json.loads(line)
        except: continue
        msg=m.get('message',m)
        role=msg.get('role') or m.get('type')
        content=msg.get('content')
        if role=='assistant' and isinstance(content,list):
            turns+=1
            for c in content:
                if c.get('type')=='tool_use': calls.append((c['id'],c['name'],json.dumps(c.get('input',{}),separators=(',',':'))))
        if role=='user' and isinstance(content,list):
            for c in content:
                if c.get('type')=='tool_result':
                    cc=c.get('content'); 
                    if isinstance(cc,list): txt=''.join(x.get('text','') for x in cc if isinstance(x,dict))
                    else: txt=str(cc or '')
                    results[c['tool_use_id']]=len(txt)
    usage=None
    return turns,calls,results
if __name__=='__main__':
    for p in sys.argv[1:]:
        turns,calls,results=analyze(p)
        tot=0; rt=0
        print('==',os.path.basename(p),'assistant turns',turns,'tool calls',len(calls))
        for cid,name,args in calls:
            n=results.get(cid,0); tot+=n
            if 'realtime' in name: rt+=n
            print(f'  {n:>7} {name} {args[:140]}')
        print(f'  total result chars {tot} (~{tot//4} tok); realtime result chars {rt} (~{rt//4} tok)')
