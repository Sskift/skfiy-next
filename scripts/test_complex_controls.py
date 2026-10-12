#!/usr/bin/env python3
"""Real AppKit + headless Chrome MCP checks. Own fixtures only; no activation,
window guard, raises, or user browser. Receipts and focus samples are independent.
Usage: python3 scripts/test_complex_controls.py .build/debug/skfiy
"""
import json, plistlib, re, shutil, socket, subprocess, sys, threading, time, uuid
from pathlib import Path
from urllib.request import urlopen, Request
from harness import Client, Evidence, ROOT, require, wait_until
from scenario import probe, tool
from compat_baseline import chrome_app


def main():
    binary = Path(sys.argv[1] if len(sys.argv)>1 else ROOT/'.build/debug/skfiy').resolve()
    chrome_path = chrome_app()
    require(chrome_path, 'Install Chrome for Testing in ~/.cache/skfiy-test before running this fixture.')
    tool('AXProbe')  # Build before starting the sampler, so it covers launch too.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    nonce = uuid.uuid4().hex[:10]
    root = ROOT/'eval/results'/f'complex-{time.strftime("%Y%m%d-%H%M%S")}-{nonce}'
    root.mkdir(parents=True)
    evidence = Evidence(root); failures=[]; children=[]; samples=[]; sample_errors=[]; done=threading.Event(); targets=set()
    def sample():
        while not done.is_set():
            try: samples.append(probe('front'))
            except Exception as e: sample_errors.append(str(e)); evidence.record('sampler-error',error=str(e))
            done.wait(.1)
    sampler=threading.Thread(target=sample,daemon=True);sampler.start()
    client=Client(binary,evidence,env={'SKFIY_CURSOR':'0'})
    def check(label, ok, detail=''):
        evidence.record('check',label=label,ok=bool(ok),detail=detail)
        print(('PASS ' if ok else 'FAIL ')+label+(' | '+str(detail)[:250] if detail else ''),flush=True)
        if not ok: failures.append(label)
    def call(name,**kw): return client.call(name,allow_error=True,rpc_timeout=90,**kw)
    try:
        app=root/'Complex.app';macos=app/'Contents/MacOS';macos.mkdir(parents=True)
        with (app/'Contents/Info.plist').open('wb') as f:
            plistlib.dump({'CFBundleIdentifier':f'com.skfiy.complex.{nonce}','CFBundleExecutable':'Complex','CFBundlePackageType':'APPL','NSPrincipalClass':'NSApplication','LSUIElement':True,'NSAppSleepDisabled':True},f)
        subprocess.run(['swiftc','-O',str(ROOT/'scripts/fixtures/ComplexFixture.swift'),'-o',str(macos/'Complex')],check=True,capture_output=True)
        subprocess.run(['codesign','--force','--sign','-',str(app)],check=True,capture_output=True)
        native=subprocess.Popen([str(macos/'Complex'),str(root)],stdout=(root/'native.log').open('w'),stderr=subprocess.STDOUT);children.append(native);targets.add(native.pid)
        state=lambda:json.loads((root/'state.json').read_text())
        require(wait_until(lambda:state().get('pid')==native.pid), 'native start')
        a={'app':f'pid:{native.pid}'}
        call('get_app_state',**a)
        def press_native(label,target,id):
            before=state()['counts'].copy();r=call('click',**a,target=target)
            wait_until(lambda:state()['counts']!=before,timeout=2)
            after=state()['counts'];changes={k:after.get(k,0)-before.get(k,0) for k in set(after)|set(before) if after.get(k,0)!=before.get(k,0)}
            check(label,not r['is_error'] and changes=={id:1},r['text'])
        press_native('native tooltip icon',{'name':'Archive fixture','role':'button'},'archive-icon')
        press_native('native unnamed identifier',{'identifier':'unnamed-icon'},'unnamed-icon')
        r=call('locate',**a,target={'name':'Edit','role':'button'})
        check('native ambiguity supplies screenshot',not r['is_error'] and '3 candidates' in r['text'] and bool(r['images']),r['text'])
        before=state()['counts'];r=call('click',**a,target={'name':'Edit','role':'button'})
        check('native ambiguity clicks nothing',r['is_error'] and state()['counts']==before,r['text'])
        press_native('native row and column',{'name':'Edit','role':'button','row':'Bob','column':'Action'},'edit-Bob')
        (root/'command').write_text('reverse');require(wait_until(lambda:state()['rows'][0]=='Carol'),'reverse')
        press_native('native re-resolves reordered row',{'name':'Edit','role':'button','row':'Alice','column':'Action'},'edit-Alice')

        server=subprocess.Popen([sys.executable,str(ROOT/'scripts/compat_server.py'),'--port',str(port),'--root',str(ROOT/'scripts/fixtures'),'--events',str(root/'events')],stdout=(root/'server.log').open('w'),stderr=subprocess.STDOUT);children.append(server)
        require(wait_until(lambda:urlopen(f'http://127.0.0.1:{port}/state?run=none').status==200),'server start')
        profile=root/'profile';host=root/'skfiy-host';shutil.copy2(binary,host)
        subprocess.run([str(host),'install-browser-bridge','--user-data-dir',str(profile)],check=True,capture_output=True)
        chrome=subprocess.Popen([str(chrome_path/'Contents/MacOS/Google Chrome for Testing'),f'--user-data-dir={profile}','--headless=new','--window-size=1000,900','--no-first-run','--no-default-browser-check','--disable-features=DisableLoadExtensionCommandLineSwitch',f'--load-extension={ROOT/"browser-extension"}','about:blank'],stdout=(root/'chrome.log').open('w'),stderr=subprocess.STDOUT);children.append(chrome);targets.add(chrome.pid)
        browser={'browser':str(chrome.pid)}
        require(wait_until(lambda:not call('browser_tabs',**browser)['is_error'],timeout=30),'browser bridge')
        tabs_before=call('browser_tabs',**browser)['text']
        opened=call('browser_open',**browser,url=f'http://127.0.0.1:{port}/complex.html?run={nonce}')
        tab=int(re.search(r'tab (\d+)',opened['text'])[1]);b={**browser,'tab_id':tab}
        def report():return json.load(urlopen(f'http://127.0.0.1:{port}/state?run={nonce}'))
        def page():return report().get('state',{})
        require(wait_until(lambda:page().get('run')==nonce),'page start')
        def press(label,target,id,**extra):
            before=page()['counts'].copy();r=call('browser_click',**b,target=target,**extra)
            wait_until(lambda:page()['counts']!=before,timeout=2)
            after=page()['counts'];changes={k:after.get(k,0)-before.get(k,0) for k in set(after)|set(before) if after.get(k,0)!=before.get(k,0)}
            check(label,not r['is_error'] and changes=={id:1},r['text']);return r
        press('browser SVG title','Archive fixture','archive')
        press('browser unnamed identifier',{'identifier':'unnamed'},'unnamed')
        press('browser row and column',{'name':'Edit','role':'button','row':'Bob','column':'Action'},'edit-Bob')
        r=call('browser_type',**b,target={'role':'text field','row':'Carol','column':'Email'},text='updated@example.test',clear=True)
        check('browser cell field',not r['is_error'] and wait_until(lambda:'updated@example.test' in page()['emails']),r['text'])
        press('browser reorder','Reverse rows','reverse')
        press('browser row after reorder',{'name':'Edit','role':'button','row':'Alice','column':'Action'},'edit-Alice')
        press('browser shadow-root labelledby','Shadow action','shadow-action')
        before=page()['counts'];r=call('browser_click',**b,target={'name':'Edit','role':'button'})
        check('browser ambiguous click refused',r['is_error'] and page()['counts']==before,r['text'])
        before=page();r=call('browser_scroll',**b,target={'identifier':'nested-start'},direction='down')
        check('browser nested button scrolls its container',not r['is_error'] and wait_until(lambda:page()['nested']>before['nested']) and page()['scrollY']==before['scrollY'],r['text'])
        r=call('browser_scroll',**b,target={'identifier':'nested'},direction='down',pages=50)
        before=page();r=call('browser_scroll',**b,target={'identifier':'nested'},direction='down')
        check('browser boundary never spills to page','Scroll boundary reached' in r['text'] and page()['scrollY']==before['scrollY'],r['text'])
        r=call('browser_scroll',**b,target={'identifier':'nested-start'},direction='to')
        check('browser reveal target without clicking',not r['is_error'] and wait_until(lambda:page()['nested']==0) and 'nested-start' not in page()['counts'],r['text'])
        r=call('browser_scroll',**b,target={'identifier':'virtual'},direction='down',until={'name':'Person 32','role':'row'},max_scrolls=10)
        check('browser bounded virtual-list search',not r['is_error'] and 'Found' in r['text'] and page()['virtual']>600,r['text'])
        press('browser virtual-list click re-resolves',{'name':'Person 32','role':'row'},'person-32')
        before=page()['counts'];r=call('browser_scroll',**b,target={'identifier':'virtual'},direction='down',until='Not present',max_scrolls=2)
        check('browser missing virtual target bounded',r['is_error'] and page()['counts']==before,r['text'])
        r=call('browser_locate',**b,target={'name':'Person 36','role':'row'})
        old_index=int(re.search(r'\[(\d+)\]',r['text'])[1])
        body=json.dumps({'state':{'run':nonce+'-command','recycle':True}}).encode()
        urlopen(Request(f'http://127.0.0.1:{port}/event',data=body)).read()
        require(wait_until(lambda:report().get('event')=='recycled'), 'fixture actually recycled its DOM row')
        r=call('browser_click',**b,index=old_index)
        check('browser recycled DOM index is refused',r['is_error'] and 'recycled' in r['text'] and page()['counts']==before,r['text'])
        call('browser_scroll',**b,direction='up',pages=50)
        shot=call('browser_state',**b,background_screenshot=True)
        check('browser background screenshot',not shot['is_error'] and bool(shot['images']),shot['text'][:180])
        # Verify the screenshot depicts the new receipt through independent Vision OCR.
        if shot['images']:
            recognized=probe('ocr',shot['images'][0]);check('browser screenshot shows changed receipt',any('RECEIPT person-32 1' in line for line in recognized['lines']),str(recognized)[:250])
        after=call('browser_tabs',**browser)['text']
        shown=lambda t:re.findall(r'tab (\d+) \[shown\]',t)
        check('browser original active tab unchanged',shown(after)==shown(tabs_before),after)
        active=int(shown(tabs_before)[0])
        call('browser_open',**browser,tab_id=active,url=f'http://127.0.0.1:{port}/complex.html?run={nonce}-active')
        r=call('browser_state',**browser,tab_id=active,background_screenshot=True)
        check('explicit background capture uses debugger even for active tab',bool(r['images']) and "taken through Chrome's debugger" in r['text'],r['text'][-200:])
    finally:
        client.close()
        for p in reversed(children):
            if p.poll() is None:
                p.terminate()
                try:p.wait(timeout=8)
                except subprocess.TimeoutExpired:p.kill();p.wait()
        done.set();sampler.join(timeout=25)
        (root/'focus.json').write_text(json.dumps(samples))
        check('no fixture took local focus or top window',bool(samples) and not sample_errors and not any(s.get('frontPID') in targets or s.get('topPID') in targets for s in samples),f'{len(samples)} samples; target pids {targets}')
        shutil.rmtree(root/'profile',ignore_errors=True)
        evidence.events.close()
    print('Evidence:',root,flush=True)
    require(not failures, f'{len(failures)} checks failed: {failures}')

if __name__=='__main__':main()
