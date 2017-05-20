var constants = require('../models/constants');

exports.up = function (knex, Promise) {
    return Promise.all([
        knex.raw('DROP TRIGGER IF EXISTS camp_members_groups_after_ins').then(
            knex.raw(
                "CREATE TRIGGER camp_members_groups_after_ins AFTER INSERT ON camp_members " +
                "FOR EACH ROW " +
                "BEGIN " +
                "INSERT INTO users_groups_membership (group_id, user_id, status) VALUES (new.camp_id, new.user_id, new.status); " +
                "END"
            )
        ),
        !knex.schema.hasColumn("events", "gate_status") ?
            knex.schema.table("events", table => {
                table.enu("gate_status", constants.EVENT_GATE_STATUS);
            }).then(
                knex.raw("update events set gate_status='early_arrival'")
            )
            : ''

    ])
};

exports.down = function (knex, Promise) {
    return Promise.all([]);
};
