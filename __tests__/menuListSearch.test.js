/**
 * GET /menu (menuController.getAllMenuItems): short search terms are
 * regex-escaped and the page size is capped. Models mocked; no database.
 */
const mockCount = jest.fn();
const mockFind = jest.fn();
let chain;

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/menuItem', () => ({
    countDocuments: (...a) => mockCount(...a),
    find: (...a) => mockFind(...a),
}));
jest.mock('../models/order', () => ({}));
jest.mock('../models/category', () => ({}));
jest.mock('../models/branch', () => ({}));

const { getAllMenuItems } = require('../controllers/menuController');

const makeRes = () => {
    const res = { headers: {} };
    res.set = jest.fn(() => res);
    res.vary = jest.fn(() => res);
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
};
const makeReq = (query) => ({ query, headers: {}, restaurant: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });

beforeEach(() => {
    chain = { populate: jest.fn(() => chain), sort: jest.fn(() => chain), skip: jest.fn(() => chain), limit: jest.fn(() => chain), lean: jest.fn(() => Promise.resolve([])) };
    mockCount.mockReset().mockResolvedValue(0);
    mockFind.mockReset().mockReturnValue(chain);
});

test('short search: regex metacharacters are escaped', async () => {
    const res = makeRes();
    await getAllMenuItems(makeReq({ search: '.*' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const q = mockCount.mock.calls[0][0];
    expect(q.name).toEqual({ $regex: '^\\.\\*', $options: 'i' });
    expect(q.$text).toBeUndefined();
});

test('long search uses the text index, not a regex', async () => {
    await getAllMenuItems(makeReq({ search: 'pizza' }), makeRes());
    const q = mockCount.mock.calls[0][0];
    expect(q.$text).toEqual({ $search: 'pizza' });
    expect(q.name).toBeUndefined();
});

test('array search value is not trusted as a string', async () => {
    const res = makeRes();
    await getAllMenuItems(makeReq({ search: ['(', 'a'] }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const q = mockCount.mock.calls[0][0];
    expect(q.name).toBeUndefined();
    expect(q.$text).toBeUndefined();
});

test.each([
    [undefined, 20], ['5', 5], ['100', 100], ['5000', 100], ['0', 20], ['-4', 1], ['abc', 20],
])('limit %p -> %p', async (limit, expected) => {
    const res = makeRes();
    await getAllMenuItems(makeReq({ limit }), res);
    expect(chain.limit).toHaveBeenCalledWith(expected);
    expect(res.json.mock.calls[0][0].pageSize).toBe(expected);
});

test('page is floored at 1 and drives skip', async () => {
    await getAllMenuItems(makeReq({ page: '3', limit: '10' }), makeRes());
    expect(chain.skip).toHaveBeenCalledWith(20);
    await getAllMenuItems(makeReq({ page: '-2', limit: '10' }), makeRes());
    expect(chain.skip).toHaveBeenLastCalledWith(0);
});
