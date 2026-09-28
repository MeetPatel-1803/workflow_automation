import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWorkflowDto } from './create-workflow.dto';

/** Builds a valid base workflow body, overridable per test. */
function workflowBody(
  overrides: Partial<{ name: string; steps: unknown[] }> = {},
) {
  return {
    name: 'My workflow',
    steps: [
      {
        id: 'step-1',
        type: 'http',
        config: { method: 'GET', url: 'https://example.com' },
      },
      { id: 'step-2', type: 'complete' },
    ],
    ...overrides,
  };
}

async function validateBody(body: unknown) {
  const dto = plainToInstance(CreateWorkflowDto, body);
  return validate(dto);
}

function messagesOf(
  errors: Awaited<ReturnType<typeof validateBody>>,
): string[] {
  const flat: string[] = [];
  for (const error of errors) {
    flat.push(...Object.values(error.constraints ?? {}));
    if (error.children?.length) {
      flat.push(...messagesOf(error.children));
    }
  }
  return flat;
}

describe('CreateWorkflowDto', () => {
  it('passes for a minimal valid workflow', async () => {
    const errors = await validateBody(workflowBody());
    expect(errors).toHaveLength(0);
  });

  describe('http step', () => {
    it('passes with a valid config', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 's1',
              type: 'http',
              config: {
                method: 'POST',
                url: 'https://api.example.com/hook',
                headers: { 'x-api-key': 'abc' },
                body: { foo: 'bar' },
                timeoutMs: 5000,
              },
            },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(errors).toHaveLength(0);
    });

    it('fails when url is missing', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            { id: 's1', type: 'http', config: { method: 'GET' } },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(messagesOf(errors).join(' ')).toMatch(/url/i);
    });

    it('fails with an invalid URL format', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 's1',
              type: 'http',
              config: { method: 'GET', url: 'not-a-url' },
            },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/url/i);
    });

    it.each([
      ['below min', 50],
      ['above max', 70_000],
    ])(
      'fails when timeoutMs is out of bounds (%s)',
      async (_label, timeoutMs) => {
        const errors = await validateBody(
          workflowBody({
            steps: [
              {
                id: 's1',
                type: 'http',
                config: {
                  method: 'GET',
                  url: 'https://example.com',
                  timeoutMs,
                },
              },
              { id: 's2', type: 'complete' },
            ],
          }),
        );
        expect(messagesOf(errors).join(' ')).toMatch(/timeoutMs/i);
      },
    );

    it('fails when headers has a non-string value', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 's1',
              type: 'http',
              config: {
                method: 'GET',
                url: 'https://example.com',
                headers: { count: 5 },
              },
            },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/headers/i);
    });
  });

  describe('condition step', () => {
    it('passes when not at index 0', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 's1',
              type: 'http',
              config: { method: 'GET', url: 'https://example.com' },
            },
            {
              id: 's2',
              type: 'condition',
              config: { field: 'status', operator: 'eq', value: 'ok' },
            },
            { id: 's3', type: 'complete' },
          ],
        }),
      );
      expect(errors).toHaveLength(0);
    });

    it('fails when at index 0', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 's1',
              type: 'condition',
              config: { field: 'status', operator: 'eq', value: 'ok' },
            },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/condition/i);
    });
  });

  describe('delay step', () => {
    it('passes with a valid durationMs', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            { id: 's1', type: 'delay', config: { durationMs: 5000 } },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(errors).toHaveLength(0);
    });

    it.each([
      ['below min', 500],
      ['above max', 90_000_000],
    ])(
      'fails when durationMs is out of bounds (%s)',
      async (_label, durationMs) => {
        const errors = await validateBody(
          workflowBody({
            steps: [
              { id: 's1', type: 'delay', config: { durationMs } },
              { id: 's2', type: 'complete' },
            ],
          }),
        );
        expect(messagesOf(errors).join(' ')).toMatch(/durationMs/i);
      },
    );
  });

  describe('cross-step structural rules', () => {
    it('fails on duplicate step ids', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 'dup',
              type: 'http',
              config: { method: 'GET', url: 'https://example.com' },
            },
            { id: 'dup', type: 'complete' },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/duplicate/i);
    });

    it('fails with zero complete steps', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 's1',
              type: 'http',
              config: { method: 'GET', url: 'https://example.com' },
            },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/complete/i);
    });

    it('fails when the complete step is not last', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            { id: 's1', type: 'complete' },
            {
              id: 's2',
              type: 'http',
              config: { method: 'GET', url: 'https://example.com' },
            },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/complete/i);
    });

    it('fails with more than one complete step', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            { id: 's1', type: 'complete' },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/complete/i);
    });

    it('fails on an unrecognized step type', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            { id: 's1', type: 'teleport', config: {} },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      expect(messagesOf(errors).join(' ')).toMatch(/type/i);
    });

    it('fails when type/config are mismatched (delay type, http-shaped config)', async () => {
      const errors = await validateBody(
        workflowBody({
          steps: [
            {
              id: 's1',
              type: 'delay',
              config: { method: 'GET', url: 'https://example.com' },
            },
            { id: 's2', type: 'complete' },
          ],
        }),
      );
      // durationMs (required by delay) is missing, and method/url (not part
      // of delay's shape) are rejected as extraneous by the nested whitelist.
      expect(messagesOf(errors).join(' ')).toMatch(/durationMs/i);
    });
  });

  describe('workflow-level fields', () => {
    it('fails with an empty steps array', async () => {
      const errors = await validateBody(workflowBody({ steps: [] }));
      expect(messagesOf(errors).join(' ')).toMatch(/steps/i);
    });

    it('fails with more than 50 steps', async () => {
      const httpStep = (id: string) => ({
        id,
        type: 'http',
        config: { method: 'GET', url: 'https://example.com' },
      });
      const steps = [
        ...Array.from({ length: 50 }, (_, i) => httpStep(`s${i}`)),
        { id: 'complete', type: 'complete' },
      ];
      const errors = await validateBody(workflowBody({ steps }));
      expect(messagesOf(errors).join(' ')).toMatch(/steps/i);
    });

    it('fails with an empty name', async () => {
      const errors = await validateBody(workflowBody({ name: '' }));
      expect(messagesOf(errors).join(' ')).toMatch(/name/i);
    });
  });
});
