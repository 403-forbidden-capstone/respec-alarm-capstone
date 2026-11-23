#!/usr/bin/env python3
"""Synthetic-only E2E: train current-hist mean, validate manifest + live CatBoost predict."""
from __future__ import annotations
import csv
import importlib.util
import json
import subprocess
import sys
import tempfile
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
        metrics=json.loads((out/'metrics.json').read_text(encoding='utf-8'))
        assert sum(metrics['user_counts'].values())==120
        print('SYNTHETIC_PROTOCOL_PASS',json.dumps({
            'users':120,'sessions':1680,'causal_examples':len(samples),
            'test_baseline_MAE':metrics['test']['baseline']['MAE'],
            'test_model_MAE':metrics['test']['model']['MAE'],
            'underprediction_rate':metrics['test']['model']['under_rate'],
            'old_survey_manifest':'blocked','incompatible_requests':'blocked',
        }))
if __name__=='__main__':
    main()
