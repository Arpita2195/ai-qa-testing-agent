ALTER TABLE bug_reports
  ALTER COLUMN result_id DROP NOT NULL,
  ADD COLUMN api_result_id uuid REFERENCES api_test_results(id) ON DELETE CASCADE,
  ADD CONSTRAINT bug_reports_api_result_id_unique UNIQUE (api_result_id);

CREATE OR REPLACE FUNCTION create_api_bug_report()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'failed' THEN
    INSERT INTO bug_reports
      (id, api_result_id, title, description, severity, classification,
       probable_cause, reproduction_steps, status)
    SELECT
      gen_random_uuid(),
      NEW.id,
      endpoint.name,
      concat(
        'API check failed: expected HTTP ',
        endpoint.expected_status,
        ', received ',
        COALESCE(NEW.actual_status::text, 'no response'),
        CASE WHEN NEW.error_message IS NOT NULL THEN concat('. ', NEW.error_message) ELSE '' END
      ),
      'medium',
      'unknown',
      NEW.error_message,
      jsonb_build_array(
        jsonb_build_object(
          'method', endpoint.method,
          'path', endpoint.path,
          'expected_status', endpoint.expected_status,
          'actual_status', NEW.actual_status
        )
      ),
      'suspected'
    FROM api_endpoints endpoint
    WHERE endpoint.id = NEW.endpoint_id
    ON CONFLICT (api_result_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER api_test_results_bug_report
AFTER INSERT ON api_test_results
FOR EACH ROW
EXECUTE FUNCTION create_api_bug_report();

INSERT INTO bug_reports
  (id, api_result_id, title, description, severity, classification,
   probable_cause, reproduction_steps, status)
SELECT
  gen_random_uuid(),
  result.id,
  endpoint.name,
  concat(
    'API check failed: expected HTTP ',
    endpoint.expected_status,
    ', received ',
    COALESCE(result.actual_status::text, 'no response'),
    CASE WHEN result.error_message IS NOT NULL THEN concat('. ', result.error_message) ELSE '' END
  ),
  'medium',
  'unknown',
  result.error_message,
  jsonb_build_array(
    jsonb_build_object(
      'method', endpoint.method,
      'path', endpoint.path,
      'expected_status', endpoint.expected_status,
      'actual_status', result.actual_status
    )
  ),
  'suspected'
FROM api_test_results result
JOIN api_endpoints endpoint ON endpoint.id = result.endpoint_id
WHERE result.status = 'failed'
ON CONFLICT (api_result_id) DO NOTHING;
