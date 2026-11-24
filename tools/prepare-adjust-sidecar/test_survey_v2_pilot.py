import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("survey_v2_pilot", HERE / "survey_v2_pilot.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SurveyV2PilotTest(unittest.TestCase):
    def setUp(self):
        self.features = {
            "weekday_code": "2", "평토일구분코드": "1",
            "휴일종류코드": "__MISSING__", "연령코드": "2",
            "baseline_observed": 30.0,
        }
        self.request = {
            "model": module.MODEL,
            "baseline_definition": module.BASELINE,
            "history_count": 10,
            "features": self.features,
        }
        self.model = Mock()
        self.model.predict.return_value = [0.0]

    def test_returns_original_survey_target_without_relabeling(self):
        value = module.predict(self.model, self.request)
        self.assertEqual(value["training_target"], "survey_start_cluster_proxy")
        self.assertEqual(value["baseline_definition"], module.BASELINE)
        self.assertEqual(value["minutes"], 30.0)

    def test_rejects_short_history_and_wrong_baseline(self):
        for invalid in [
            {**self.request, "history_count": 9},
            {**self.request, "history_count": True},
            {**self.request, "baseline_definition": "mean_last_30_valid_prep_alarm_location_v1"},
            {**self.request, "features": {**self.features, "baseline_observed": 0}},
            {**self.request, "features": {**self.features, "연령코드": "bad"}},
        ]:
            with self.assertRaises(ValueError):
                module.predict(self.model, invalid)

    def test_rejects_mislabelled_manifest(self):
        # No actual binary dependency needed to verify that a forged manifest
        # cannot pass the model provenance check.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "v2.cbm"
            path.write_bytes(b"not-a-real-model")
            for manifest in (
                {"model":module.MODEL, "training_target":"actual_start_depart"},
                {"model":module.MODEL, "training_target":"survey_start_cluster_proxy"},
            ):
                path.with_suffix(".manifest.json").write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    module.load_verified_model(path)


if __name__ == "__main__":
    unittest.main()
