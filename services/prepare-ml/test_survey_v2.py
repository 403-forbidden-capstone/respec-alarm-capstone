"""No CBM weights in Git/CI: verify request contract with a fake predictor."""
import unittest
from unittest.mock import Mock

from survey_v2_model import (
    BASELINE,
    InvalidSurveyRequest,
    MODEL_NAME,
    OriginalSurveyV2,
    TRAINING_TARGET,
)


class SurveyV2ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.service = object.__new__(OriginalSurveyV2)
        self.service.model = Mock()
        self.service.model.predict.return_value = [0.0]
        self.request = {
            "model": MODEL_NAME,
            "baseline_definition": BASELINE,
            "history_count": 10,
            "features": {
                "weekday_code": "2", "평토일구분코드": "1",
                "휴일종류코드": "__MISSING__", "연령코드": "2",
                "baseline_observed": 30.0,
            },
        }

    def test_original_survey_provenance_and_ratio(self):
        output = self.service.predict(self.request)
        self.assertEqual(output["model"], MODEL_NAME)
        self.assertEqual(output["training_target"], TRAINING_TARGET)
        self.assertEqual(output["baseline_definition"], BASELINE)
        self.assertEqual(output["prediction_type"], "ratio")
        self.assertEqual(output["minutes"], 30.0)
        self.assertEqual(output["ratio"], 1.0)
        self.service.model.predict.assert_called_once_with([["2","1","__MISSING__","2",30.0]])

    def test_refuses_nine_or_unbounded_history(self):
        for n in (9, 31, 0, True, "10"):
            with self.subTest(n=n):
                with self.assertRaises(InvalidSurveyRequest):
                    self.service.predict({**self.request, "history_count": n})

    def test_refuses_invalid_features_and_baseline(self):
        for name, value in (
            ("연령코드", "0"), ("평토일구분코드", "5"),
            ("weekday_code", "8"), ("baseline_observed", 0),
            ("baseline_observed", 241), ("baseline_observed", float("nan")),
        ):
            with self.subTest(name=name, value=value):
                features = {**self.request["features"], name: value}
                with self.assertRaises(InvalidSurveyRequest):
                    self.service.predict({**self.request, "features": features})

    def test_refuses_non_survey_training_contract(self):
        for contract in (
            "mean_last_30_valid_prep_alarm_location_v1",
            "onboarding_pure_minutes",
        ):
            with self.subTest(contract=contract):
                with self.assertRaises(InvalidSurveyRequest):
                    self.service.predict({**self.request, "baseline_definition": contract})

    def test_outside_ratio_guardrail_refused(self):
        self.service.model.predict.return_value = [1.5]
        with self.assertRaises(InvalidSurveyRequest):
            self.service.predict(self.request)


if __name__ == "__main__":
    unittest.main()
