#!/usr/bin/env python3
"""Synthetic-only E2E: train current-hist mean, validate manifest + live CatBoost predict."""
from __future__ import annotations
import csv
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor

ROOT = Path(__file__).resolve().parent
FIELDS = ['user_id','prepare_started_at','departed_at','prepare_started_source','departed_source',
          'weekday_code','평토일구분코드','휴일종류코드','연령코드']
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    out = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(out)
    return out


def http_test(model_path: Path, request: dict, target: str, working: Path) -> dict:
    """Live loopback HTTP subprocess with a real synthetically trained model."""
    assert target == 'alarm_dismiss_location_proxy'
    key = 'local-qa-only-model-auth-key-strong'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]

    env = {**os.environ,
           'PREP_ADJUST_HOST':'127.0.0.1',
           'PREP_ADJUST_PORT':str(port),
           'PREP_ADJUST_API_TOKEN':key,
           'PREP_ADJUST_MODEL_PATH':str(model_path),
           'PREP_ADJUST_ALLOW_DISMISS_PROXY':'1'}
    endpoint = f'http://127.0.0.1:{port}'

    def request_json(path: str, payload=None, auth: str | None=None, raw=None):
        headers = {}
        if auth is not None:
            headers['x-api-key'] = auth
        if payload is not None or raw is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(payload).encode() if raw is None else raw
            req = Request(endpoint+path, data=body, headers=headers, method='POST')
        else:
            req = Request(endpoint+path,headers=headers,method='GET')
        try:
            with urlopen(req,timeout=4) as response:
                return response.status, json.loads(response.read().decode())
        except HTTPError as error:
            return error.code, json.loads(error.read().decode())

    def blocked_startup(override: dict, filename: str):
        new_path=working/f'{filename}.cbm'
        new_path.write_bytes(model_path.read_bytes())
        manifest=json.loads(model_path.with_suffix('.manifest.json').read_text())
        manifest.update(override)
        new_path.with_suffix('.manifest.json').write_text(json.dumps(manifest))
        bad_env={**env,'PREP_ADJUST_MODEL_PATH':str(new_path)}
        with (working/f'{filename}.log').open('w') as log:
            p=subprocess.Popen([sys.executable,str(ROOT/'server.py')],
                               env=bad_env,stdout=log,stderr=subprocess.STDOUT)
            try:
                p.wait(timeout=12)
            except subprocess.TimeoutExpired:
                p.kill();p.wait()
                raise AssertionError('server started with incompatible model manifest')
            assert p.returncode != 0, f'accepted manifest override: {override}'

    blocked_startup({'baseline_definition':'previous_day_survey_diary'},'bad-baseline')
    blocked_startup({'sha256':'0'*64},'bad-hash')
    blocked_startup({'training_target':'survey_start_cluster_proxy'},'bad-target')
    blocked_startup({'feature_names':['weekday_code']},'bad-features')

    with (working/'http-server.log').open('w') as log:
        proc=subprocess.Popen([sys.executable,str(ROOT/'server.py')],
                              env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            until=time.monotonic()+20
            while time.monotonic()<until:
                if proc.poll() is not None:
                    raise AssertionError('model sidecar exited early: '+(working/'http-server.log').read_text()[-1200:])
                try:
                    status,body=request_json('/health')
                    if status==200 and body.get('ok') is True:
                        break
                except (URLError,ConnectionError,TimeoutError):
                    time.sleep(.2)
            else:
                raise AssertionError('model sidecar HTTP startup exceeded 20 seconds')

            status,body=request_json('/predict',request)
            assert status==401,('auth missing',status,body)
            status,body=request_json('/predict',request,auth='wrong-token')
            assert status==401,('auth wrong',status,body)
            status,body=request_json('/predict',request,auth=key)
            assert status==200,('valid request failed',status,body)
            assert body['model']=='prep_start_ratio_v2'
            assert body['baseline_definition']==request['baseline_definition']
            assert body['training_target']=='alarm_dismiss_location_proxy'
            assert body['prediction_type']=='ratio'
            assert 5<=body['minutes']<=240

            for invalid in [
                {**request,'history_count':9},
                {**request,'history_count':31},
                {**request,'baseline_definition':'previous_day_survey_diary'},
                {**request,'model':'unapproved_model'},
                {**request,'features':{**request['features'],'baseline_observed':-1}},
            ]:
                status, _=request_json('/predict',invalid,auth=key)
                assert status==400,('bad request should fail',invalid,status)
            status,_=request_json('/predict',auth=key,raw=b'{"invalid":')
            assert status==400,('malformed JSON should fail',status)
            status,_=request_json('/predict',auth=key,raw=b'x'*4097)
            assert status==413,('oversized payload should fail',status)
            status,_=request_json('/wrong',request,auth=key)
            assert status==404,('unknown route should fail',status)
            status,_=request_json('/health')
            assert status==200
            return {'http_200_valid':True,'unauthenticated_401':True,
                    'invalid_400':True,'oversized_413':True,
                    'unknown_route_404':True,'tampered_manifest_blocked':4,
                    'preview_only':True}
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait()

def main():
    train = module('train_qa','train.py')
    api = module('server_qa','server.py')
    assert train.BASELINE_DEFINITION == api.BASELINE_DEFINITION
    rng = np.random.default_rng(20261123)
    with tempfile.TemporaryDirectory(prefix='fictional_only_') as temp:
        base = Path(temp)
        csv_path = base / 'synthetic.csv'
        with csv_path.open('w',encoding='utf-8',newline='') as file:
            writer = csv.DictWriter(file,fieldnames=FIELDS);writer.writeheader()
            for u in range(120):
                individual = rng.normal(26,3)
                for day in range(14):
                    depart = datetime(2026,7,1,tzinfo=timezone.utc)+timedelta(days=day,hours=u%12)
                    minutes = int(np.clip(round(individual+(day%7==0)*3+rng.normal(0,2)),10,90))
                    writer.writerow({'user_id':f'synthetic-{u:03}',
                        'prepare_started_at':(depart-timedelta(minutes=minutes)).isoformat(),
                        'departed_at':depart.isoformat(),'prepare_started_source':'PREPARE_ALARM',
                        'departed_source':'LOCATION','weekday_code':str((depart.weekday()+1)%7),
                        '평토일구분코드':'2' if depart.weekday()==5 else '3' if depart.weekday()==6 else '1',
                        '휴일종류코드':'__MISSING__','연령코드':str(u%8+1)})
        samples = train.build_samples(csv_path)
        assert len(samples)==120*4
        assert (samples.history_count >= 10).all()
        original = train.pd.read_csv(csv_path)
        first = original[original.user_id=='synthetic-000']
        durations=(train.pd.to_datetime(first.departed_at)-train.pd.to_datetime(first.prepare_started_at)).dt.total_seconds()/60
        from math import isclose
        assert isclose(float(samples[samples.user_id=='synthetic-000'].iloc[0].baseline_observed),float(durations.iloc[:10].mean()))
        out = base/'trained'
        subprocess.run([sys.executable,str(ROOT/'train.py'),'--sessions-csv',str(csv_path),'--out-dir',str(out)],check=True,capture_output=True)
        model_path=out/'prep_ratio_dismiss_location_proxy.cbm'
        manifest=json.loads((out/'prep_ratio_dismiss_location_proxy.manifest.json').read_text(encoding='utf-8'))
        target=api.verify_manifest(manifest,model_path)
        assert target=='alarm_dismiss_location_proxy'
        assert manifest['baseline_definition']==train.BASELINE_DEFINITION
        assert manifest['minimum_history']==10 and manifest['history_window']==30
        for bad in [{**manifest,'baseline_definition':'previous_day_survey_diary'},
                    {**manifest,'training_target':'survey_start_cluster_proxy'}]:
            try:
                api.verify_manifest(bad,model_path)
                raise AssertionError('incompatible model accepted')
            except ValueError:
                pass
        model=CatBoostRegressor();model.load_model(str(model_path))
        row=samples.iloc[0]
        features={cat:str(row[cat]) for cat in train.CATS}
        features['baseline_observed']=float(row.baseline_observed)
        request={'model':api.MODEL_NAME,'baseline_definition':train.BASELINE_DEFINITION,
                 'history_count':int(row.history_count),'features':features}
        result=api.predict(model,request,target)
        assert result['baseline_definition']==train.BASELINE_DEFINITION
        assert result['training_target']=='alarm_dismiss_location_proxy'
        assert 5<=result['minutes']<=240
        assert abs(result['minutes']-result['ratio']*features['baseline_observed'])<.02
        for changed in [{**request,'baseline_definition':'previous_day_survey_diary'},
                        {**request,'history_count':9}]:
            try:
                api.predict(model,changed,target)
                raise AssertionError('incompatible request accepted')
            except ValueError:
                pass
        http_result=http_test(model_path,request,target,base)
        metrics=json.loads((out/'metrics.json').read_text(encoding='utf-8'))
        assert sum(metrics['user_counts'].values())==120
        print('SYNTHETIC_PROTOCOL_PASS',json.dumps({
            'users':120,'sessions':1680,'causal_examples':len(samples),
            'test_baseline_MAE':metrics['test']['baseline']['MAE'],
            'test_model_MAE':metrics['test']['model']['MAE'],
            'underprediction_rate':metrics['test']['model']['under_rate'],
            'old_survey_manifest':'blocked','incompatible_requests':'blocked',
            'http_contract':http_result,
        }))
if __name__=='__main__':
    main()
